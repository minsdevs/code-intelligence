package dev.codeintelligence.analysis.config;

import dev.codeintelligence.analysis.area.AreaType;
import dev.codeintelligence.analysis.core.AnalysisContext;
import dev.codeintelligence.analysis.core.AnalysisResult;
import dev.codeintelligence.analysis.core.AnalyzerEvidence;
import dev.codeintelligence.analysis.core.CodeAnalyzer;
import dev.codeintelligence.analysis.core.EdgeConfidence;
import dev.codeintelligence.analysis.core.FileAnalysisOutcome;
import dev.codeintelligence.analysis.core.FileCapabilityOutcome;
import dev.codeintelligence.analysis.core.FileInventory;
import dev.codeintelligence.analysis.core.GraphEdgeType;
import dev.codeintelligence.analysis.core.GraphNodeDraft;
import dev.codeintelligence.analysis.core.GraphNodeType;
import dev.codeintelligence.analysis.core.InventoriedFile;
import dev.codeintelligence.analysis.core.NaturalKeys;
import dev.codeintelligence.evidence.EvidenceKind;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.sf.jsqlparser.parser.CCJSqlParserUtil;
import net.sf.jsqlparser.statement.Statement;
import net.sf.jsqlparser.statement.Statements;
import net.sf.jsqlparser.statement.alter.Alter;
import net.sf.jsqlparser.statement.alter.AlterExpression;
import net.sf.jsqlparser.statement.create.index.CreateIndex;
import net.sf.jsqlparser.statement.create.table.ColumnDefinition;
import net.sf.jsqlparser.statement.create.table.CreateTable;
import net.sf.jsqlparser.statement.drop.Drop;
import org.springframework.stereotype.Component;

/**
 * Flyway/Liquibase SQL in version order → DB_TABLE and MIGRATION. Parse failures demote to a
 * file-level MIGRATION node plus evidence (위험 R8); the analyzer does not throw.
 */
@Component
public class SqlMigrationAnalyzer implements CodeAnalyzer {

    private static final Pattern FLYWAY_VERSION =
            Pattern.compile("^V(\\d+(?:[._]\\d+)*)__.*\\.sql$", Pattern.CASE_INSENSITIVE);

    @Override
    public boolean supports(FileInventory inventory) {
        return inventory.files().stream().anyMatch(SqlMigrationAnalyzer::isMigrationFile);
    }

    @Override
    public AnalysisResult analyze(AnalysisContext ctx) {
        GraphCollector collector = new GraphCollector();
        List<MigrationFile> files = new ArrayList<>();
        for (InventoriedFile file : ctx.inventory().files()) {
            if (!isMigrationFile(file)) {
                continue;
            }
            String text = ConfigFileSupport.read(ctx.clonePath(), file.path());
            if (text == null) {
                continue;
            }
            files.add(new MigrationFile(file, text));
        }
        files.sort(Comparator.comparing(MigrationFile::sortKey));
        Map<String, TableSchema> tables = new LinkedHashMap<>();
        for (MigrationFile file : files) {
            apply(file, tables, collector, ctx);
        }
        for (TableSchema schema : tables.values()) {
            String key = NaturalKeys.table(schema.name);
            // Span evidence: the CREATE TABLE statement's lines in its migration file (06 SQL-S).
            collector.put(GraphNodeDraft.of(
                            GraphNodeType.DB_TABLE,
                            key,
                            schema.name,
                            schema.sourcePath,
                            schema.lineStart == null ? 1 : schema.lineStart,
                            schema.lineEnd)
                    .withAreaType(AreaType.DATABASE.name())
                    .withMetadata(schema.toMetadata()));
        }
        return collector.toResult();
    }

    static boolean isMigrationFile(InventoriedFile file) {
        String path = file.path().replace('\\', '/').toLowerCase(Locale.ROOT);
        if (!path.endsWith(".sql")) {
            return false;
        }
        return path.contains("db/migration")
                || path.contains("db/changelog")
                || path.contains("/liquibase/")
                || path.contains("supabase/migrations")
                || path.contains("/migrations/")
                || FLYWAY_VERSION
                        .matcher(ConfigFileSupport.filename(file.path()))
                        .matches();
    }

    private void apply(
            MigrationFile file, Map<String, TableSchema> tables, GraphCollector collector, AnalysisContext ctx) {
        String migrationKey = NaturalKeys.migration(file.file.path());
        collector.put(GraphNodeDraft.of(
                        GraphNodeType.MIGRATION,
                        migrationKey,
                        ConfigFileSupport.filename(file.file.path()),
                        file.file.path(),
                        1,
                        ConfigFileSupport.lineCount(file.text))
                .withAreaType(AreaType.DATABASE.name())
                .withMetadata(Map.of("version", file.versionLabel())));
        collector.evidence(new AnalyzerEvidence(
                migrationKey, EvidenceKind.FILE_LINE, file.file.path(), 1, 1, ConfigFileSupport.excerpt(file.text)));
        try {
            Statements statements =
                    CCJSqlParserUtil.parseStatements(file.text, parser -> parser.withErrorRecovery(false));
            if (statements == null || statements.isEmpty()) {
                throw new IllegalStateException("no SQL statements parsed");
            }
            int applied = 0;
            // Statement line ranges come from the text segments between ';' separators (the parser keeps
            // no positions on CreateTable); they are used only when they align one-to-one.
            List<int[]> segments = statementSegments(file.text);
            boolean aligned = segments.size() == statements.size();
            for (Statement statement : statements) {
                applyStatement(
                        statement, file, tables, collector, migrationKey, aligned ? segments.get(applied) : null);
                applied++;
            }
            if (applied == 0) {
                throw new IllegalStateException("no SQL statements applied");
            }
            collector.outcome(new FileAnalysisOutcome(file.file.path(), "SUCCESS", "SQL_PARSED"));
            // Table and column declarations are this analyzer's symbol capability (06 SQL-S).
            collector.capability(new FileCapabilityOutcome(file.file.path(), "S", "SUCCESS", "SQL_SCHEMA_SYMBOLS"));
        } catch (Exception e) {
            // Per-file parse verdict (06 SQL-P): the migration stays a file-level fact, nothing is resolved.
            collector.outcome(new FileAnalysisOutcome(file.file.path(), "FAILED", "SQL_PARSE_FAILED"));
            collector.capability(new FileCapabilityOutcome(file.file.path(), "S", "FAILED", "SQL_PARSE_FAILED"));
            collector.evidence(new AnalyzerEvidence(
                    migrationKey,
                    EvidenceKind.FILE_LINE,
                    file.file.path(),
                    1,
                    1,
                    "SQL parse failed; recorded as file-level MIGRATION: "
                            + ConfigFileSupport.sanitize(e.getMessage(), ctx.clonePath())));
        }
    }

    private void applyStatement(
            Statement statement,
            MigrationFile file,
            Map<String, TableSchema> tables,
            GraphCollector collector,
            String migrationKey,
            int[] lines) {
        if (statement instanceof CreateTable create) {
            String name = tableName(create.getTable());
            if (name == null) {
                return;
            }
            TableSchema schema = tables.computeIfAbsent(name, key -> new TableSchema(key, file.file.path()));
            schema.columns.clear();
            if (lines != null && file.file.path().equals(schema.sourcePath)) {
                schema.lineStart = lines[0];
                schema.lineEnd = lines[1];
            }
            if (create.getColumnDefinitions() != null) {
                for (ColumnDefinition column : create.getColumnDefinitions()) {
                    Map<String, Object> meta = columnMeta(column.getColumnName(), column.getColDataType());
                    Integer line = columnLine(file.text, lines, column.getColumnName());
                    if (line != null) {
                        meta.put("lineStart", line);
                        meta.put("lineEnd", line);
                        if (!file.file.path().equals(schema.sourcePath)) meta.put("path", file.file.path());
                    }
                    schema.columns.add(meta);
                }
            }
            collector.edge(migrationKey, NaturalKeys.table(name), GraphEdgeType.DEPENDS_ON, EdgeConfidence.CONFIRMED);
        } else if (statement instanceof Alter alter) {
            String name = tableName(alter.getTable());
            if (name == null) {
                return;
            }
            TableSchema schema = tables.computeIfAbsent(name, key -> new TableSchema(key, file.file.path()));
            if (alter.getAlterExpressions() != null) {
                for (AlterExpression expression : alter.getAlterExpressions()) {
                    applyAlter(schema, expression);
                }
            }
            collector.edge(migrationKey, NaturalKeys.table(name), GraphEdgeType.DEPENDS_ON, EdgeConfidence.CONFIRMED);
        } else if (statement instanceof CreateIndex createIndex) {
            String name = tableName(createIndex.getTable());
            if (name == null) {
                return;
            }
            TableSchema schema = tables.computeIfAbsent(name, key -> new TableSchema(key, file.file.path()));
            String indexName = createIndex.getIndex() == null
                    ? null
                    : createIndex.getIndex().getName();
            if (indexName != null && !indexName.isBlank()) {
                schema.indexes.add(unquote(indexName));
            }
            collector.edge(migrationKey, NaturalKeys.table(name), GraphEdgeType.DEPENDS_ON, EdgeConfidence.CONFIRMED);
        } else if (statement instanceof Drop drop
                && drop.getType() != null
                && "TABLE".equalsIgnoreCase(drop.getType())
                && drop.getName() != null) {
            String name = tableName(drop.getName());
            if (name != null) {
                tables.remove(name);
            }
        }
    }

    private void applyAlter(TableSchema schema, AlterExpression expression) {
        if (expression.getColDataTypeList() == null) {
            return;
        }
        expression.getColDataTypeList().forEach(def -> {
            schema.columns.removeIf(column -> def.getColumnName().equalsIgnoreCase(String.valueOf(column.get("name"))));
            schema.columns.add(columnMeta(def.getColumnName(), def.getColDataType()));
        });
    }

    /**
     * 1-based [firstLine, lastLine] of each non-blank statement segment between top-level ';' separators,
     * skipping string literals, quoted identifiers and comments. Lines exclude the separator itself.
     */
    static List<int[]> statementSegments(String text) {
        List<int[]> segments = new ArrayList<>();
        int line = 1, segmentStartLine = -1, lastContentLine = -1;
        boolean inLineComment = false, inBlockComment = false;
        char quote = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\n') {
                line++;
                inLineComment = false;
                continue;
            }
            if (inLineComment) continue;
            if (inBlockComment) {
                if (c == '*' && i + 1 < text.length() && text.charAt(i + 1) == '/') {
                    inBlockComment = false;
                    i++;
                }
                continue;
            }
            if (quote != 0) {
                if (c == quote) quote = 0;
                continue;
            }
            if (c == '-' && i + 1 < text.length() && text.charAt(i + 1) == '-') {
                inLineComment = true;
                i++;
                continue;
            }
            if (c == '/' && i + 1 < text.length() && text.charAt(i + 1) == '*') {
                inBlockComment = true;
                i++;
                continue;
            }
            if (c == '\'' || c == '"' || c == '`') {
                quote = c;
            }
            if (c == ';') {
                if (segmentStartLine > 0) segments.add(new int[] {segmentStartLine, lastContentLine});
                segmentStartLine = -1;
                lastContentLine = -1;
                continue;
            }
            if (!Character.isWhitespace(c)) {
                if (segmentStartLine < 0) segmentStartLine = line;
                lastContentLine = line;
            }
        }
        if (segmentStartLine > 0) segments.add(new int[] {segmentStartLine, lastContentLine});
        return segments;
    }

    /**
     * The line holding a column definition: the unique statement line that starts (after whitespace) with the
     * column name as written, quoted or unquoted. Null when absent or ambiguous; the column keeps no span then.
     */
    private static Integer columnLine(String text, int[] statementLines, String columnName) {
        String name = unquote(columnName);
        if (name == null || statementLines == null) {
            return null;
        }
        String[] lines = text.split("\\r?\\n", -1);
        Integer found = null;
        for (int line = statementLines[0]; line <= Math.min(statementLines[1], lines.length); line++) {
            String stripped = lines[line - 1].strip();
            String head = stripped;
            for (String quote : List.of("\"", "`", "[")) {
                if (head.startsWith(quote)) {
                    head = head.substring(1);
                    break;
                }
            }
            if (head.regionMatches(true, 0, name, 0, name.length())
                    && head.length() > name.length()
                    && !Character.isLetterOrDigit(head.charAt(name.length()))
                    && head.charAt(name.length()) != '_') {
                if (found != null) {
                    return null;
                }
                found = line;
            }
        }
        return found;
    }

    private static Map<String, Object> columnMeta(String name, Object type) {
        Map<String, Object> column = new LinkedHashMap<>();
        column.put("name", unquote(name));
        if (type != null) {
            column.put("type", type.toString());
        }
        return column;
    }

    private static String tableName(net.sf.jsqlparser.schema.Table table) {
        if (table == null) {
            return null;
        }
        return unquote(table.getName());
    }

    private static String unquote(String name) {
        if (name == null || name.isBlank()) {
            return null;
        }
        String stripped = name.strip();
        if ((stripped.startsWith("\"") && stripped.endsWith("\""))
                || (stripped.startsWith("`") && stripped.endsWith("`"))
                || (stripped.startsWith("[") && stripped.endsWith("]"))) {
            stripped = stripped.substring(1, stripped.length() - 1);
        }
        return stripped;
    }

    static final class MigrationFile {
        final InventoriedFile file;
        final String text;

        MigrationFile(InventoriedFile file, String text) {
            this.file = file;
            this.text = text;
        }

        String versionLabel() {
            Matcher matcher = FLYWAY_VERSION.matcher(ConfigFileSupport.filename(file.path()));
            if (matcher.matches()) {
                return matcher.group(1).replace('_', '.');
            }
            return ConfigFileSupport.filename(file.path());
        }

        String sortKey() {
            Matcher matcher = FLYWAY_VERSION.matcher(ConfigFileSupport.filename(file.path()));
            if (matcher.matches()) {
                String[] parts = matcher.group(1).split("[._]");
                StringBuilder padded = new StringBuilder("0:");
                for (String part : parts) {
                    padded.append(String.format(Locale.ROOT, "%010d", Integer.parseInt(part)));
                }
                return padded.toString();
            }
            return "1:" + file.path();
        }
    }

    private static final class TableSchema {
        final String name;
        final String sourcePath;
        Integer lineStart;
        Integer lineEnd;
        final List<Map<String, Object>> columns = new ArrayList<>();
        final List<String> indexes = new ArrayList<>();

        TableSchema(String name, String sourcePath) {
            this.name = name;
            this.sourcePath = sourcePath;
        }

        Map<String, Object> toMetadata() {
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("columns", List.copyOf(columns));
            metadata.put("indexes", List.copyOf(indexes));
            return metadata;
        }
    }
}
