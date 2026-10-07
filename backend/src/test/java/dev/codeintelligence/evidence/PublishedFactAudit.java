package dev.codeintelligence.evidence;

import dev.codeintelligence.analysis.core.FileService;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectInserter;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.json.JsonMapper;

/**
 * Verifies every published fact of one snapshot against the bytes the product serves for that
 * snapshot: file hash identity (Git OID and SHA-256 manifest), line span bounds, the declared name
 * inside its span, path/package namespace and same-snapshot ownership of every projection.
 */
final class PublishedFactAudit {
    private static final Pattern IDENTIFIER = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*");
    private static final Pattern PATH_KEY =
            Pattern.compile("^(file|component|hook|store|config|migration|module):([^#]+)(#.*)?$");
    private static final Pattern JAVA_KEY = Pattern.compile("^java:([A-Za-z0-9_.$]+)(#.*)?$");

    private final JdbcTemplate jdbc;
    private final FileService files;
    private final JsonMapper json = new JsonMapper();

    PublishedFactAudit(JdbcTemplate jdbc, FileService files) {
        this.jdbc = jdbc;
        this.files = files;
    }

    record Source(byte[] bytes, List<String> lines, String oid) {}

    static final class Result {
        final Map<String, Integer> counts = new TreeMap<>();
        final List<String> failures = new ArrayList<>();
        final Map<String, Integer> nodeTypes = new TreeMap<>();

        void count(String key) {
            counts.merge(key, 1, Integer::sum);
        }

        void fail(String message) {
            if (failures.size() < 200) failures.add(message);
            count("failures");
        }

        int verifiedFacts() {
            return counts.getOrDefault("nodeSpanVerified", 0)
                    + counts.getOrDefault("nodeFileLevelVerified", 0)
                    + counts.getOrDefault("edgeSpanVerified", 0)
                    + counts.getOrDefault("edgeEndpointsVerified", 0)
                    + counts.getOrDefault("evidenceVerified", 0)
                    + counts.getOrDefault("projectionVerified", 0);
        }

        Map<String, Object> toMap() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("verifiedFacts", verifiedFacts());
            result.put("counts", counts);
            result.put("nodeTypes", nodeTypes);
            result.put("failures", failures);
            return result;
        }
    }

    Result audit(long project, long user, long snapshot, Map<String, byte[]> expectedBytes) {
        Result result = new Result();
        Map<String, Source> sources = new HashMap<>();
        Map<String, Map<String, Object>> manifest = new HashMap<>();
        for (var row : jdbc.queryForList("""
                        select e.path, e.git_oid, e.blob_sha256, e.byte_size from source_manifest_entries e
                        join source_manifests m on m.id=e.manifest_id
                        where m.snapshot_id=? and m.project_id=? and m.sealed_at is not null
                        """, snapshot, project)) manifest.put((String) row.get("path"), row);
        var fileRows =
                jdbc.queryForList("select id, path, content_hash, size from files where snapshot_id=?", snapshot);
        if (fileRows.size() != manifest.size())
            result.fail("files rows " + fileRows.size() + " != manifest " + manifest.size());
        for (var row : fileRows) {
            String path = (String) row.get("path");
            Source source = source(project, user, snapshot, path, sources, result);
            if (source == null) continue;
            var entry = manifest.get(path);
            if (entry == null) {
                result.fail("file without manifest entry " + path);
                continue;
            }
            if (!source.oid().equals(row.get("content_hash"))
                    || !source.oid().equals(entry.get("git_oid"))
                    || !sha256(source.bytes()).equals(entry.get("blob_sha256"))
                    || ((Number) entry.get("byte_size")).longValue() != source.bytes().length
                    || ((Number) row.get("size")).longValue() != source.bytes().length) {
                result.fail("hash/size identity " + path);
                continue;
            }
            byte[] expected = expectedBytes == null ? null : expectedBytes.get(path);
            if (expectedBytes != null && (expected == null || !java.util.Arrays.equals(expected, source.bytes()))) {
                result.fail("served bytes differ from the bytes imported for this snapshot " + path);
                continue;
            }
            result.count("fileHashVerified");
        }
        if (expectedBytes != null && !expectedBytes.keySet().equals(manifest.keySet()))
            result.fail("snapshot path set differs from the imported set");

        for (var node : jdbc.queryForList("""
                        select n.id, n.node_type, n.natural_key, n.name, n.line_start, n.line_end, n.file_id,
                               f.path, f.snapshot_id as file_snapshot
                        from graph_nodes n left join files f on f.id=n.file_id where n.snapshot_id=? order by n.id
                        """, snapshot)) {
            String type = (String) node.get("node_type");
            result.nodeTypes.merge(type, 1, Integer::sum);
            String key = (String) node.get("natural_key");
            Integer start = (Integer) node.get("line_start"), end = (Integer) node.get("line_end");
            if ("AMBIGUOUS".equals(type)) {
                if (start != null || end != null) result.fail("ambiguous node publishes a span " + key);
                else result.count("ambiguousWithheld");
                continue;
            }
            if (node.get("file_id") == null) {
                if (start != null) result.fail("span without a file " + key);
                else result.count("nodeWithoutSourceLocation");
                continue;
            }
            if (((Number) node.get("file_snapshot")).longValue() != snapshot) {
                result.fail("node file from another snapshot " + key);
                continue;
            }
            String path = (String) node.get("path");
            Source source = source(project, user, snapshot, path, sources, result);
            if (source == null) continue;
            if (!namespace(type, key, path, source, result)) continue;
            if (start == null && end == null) {
                result.count("nodeFileLevelVerified");
                continue;
            }
            String span = span(source, start, end);
            if (span == null) {
                result.fail("node span outside retained bytes " + key + " " + start + "-" + end + " of "
                        + source.lines().size());
                continue;
            }
            String name = (String) node.get("name");
            if ("FILE".equals(type)) {
                // A file fact spans the whole retained file and is named by its last path segment.
                if (start != 1 || end != source.lines().size() || !path.endsWith("/" + name) && !path.equals(name)) {
                    result.fail("file fact span/name " + key + " lines " + start + "-" + end + " of "
                            + source.lines().size());
                    continue;
                }
                result.count("nodeSpanVerified");
                continue;
            }
            if (!nameInSpan(type, name, span)) {
                result.fail(
                        "declared name absent from its span " + key + " name=" + name + " lines " + start + "-" + end);
                continue;
            }
            result.count("nodeSpanVerified");
        }

        for (var edge : jdbc.queryForList("""
                        select e.id, e.edge_type, e.metadata::text as metadata, s.snapshot_id as ss, t.snapshot_id as ts,
                               s.natural_key as sk, t.natural_key as tk, t.name as tname, t.node_type as ttype
                        from graph_edges e join graph_nodes s on s.id=e.source_node_id join graph_nodes t on t.id=e.target_node_id
                        where e.snapshot_id=? order by e.id
                        """, snapshot)) {
            String label = edge.get("sk") + " -" + edge.get("edge_type") + "-> " + edge.get("tk");
            if (((Number) edge.get("ss")).longValue() != snapshot
                    || ((Number) edge.get("ts")).longValue() != snapshot) {
                result.fail("edge endpoint from another snapshot " + label);
                continue;
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> metadata = json.readValue((String) edge.get("metadata"), LinkedHashMap.class);
            Object path = metadata.get("filePath"), lineStart = metadata.get("lineStart");
            if (path instanceof String file && lineStart instanceof Number first) {
                Object last = metadata.getOrDefault("lineEnd", first);
                Source source = source(project, user, snapshot, file, sources, result);
                if (source == null) continue;
                String span = span(source, first.intValue(), ((Number) last).intValue());
                if (span == null) {
                    result.fail("edge span outside retained bytes " + label + " " + first + "-" + last);
                    continue;
                }
                String target = simpleName((String) edge.get("tname"));
                if ("CALLS".equals(edge.get("edge_type")) && target != null && !span.contains(target)) {
                    result.fail("call target absent from callsite span " + label + " line " + first);
                    continue;
                }
                result.count("edgeSpanVerified");
            } else {
                result.count("edgeEndpointsVerified");
            }
        }

        for (var evidence : jdbc.queryForList("""
                        select e.id, e.file_path, e.line_start, e.line_end, n.natural_key
                        from evidences e join evidence_links l on l.evidence_id=e.id and l.subject_type='GRAPH_NODE'
                        join graph_nodes n on n.id=l.subject_id where n.snapshot_id=? order by e.id
                        """, snapshot)) {
            String path = (String) evidence.get("file_path");
            if (path == null) {
                result.count("evidenceWithoutLocation");
                continue;
            }
            Source source = source(project, user, snapshot, path, sources, result);
            if (source == null) continue;
            Integer start = (Integer) evidence.get("line_start"), end = (Integer) evidence.get("line_end");
            if (start != null && span(source, start, end == null ? start : end) == null) {
                result.fail("evidence span outside retained bytes " + evidence.get("natural_key"));
                continue;
            }
            result.count("evidenceVerified");
        }

        for (String projection : List.of(
                "select a.id, n.snapshot_id as owner from api_endpoints a join graph_nodes n on n.id=a.node_id where a.snapshot_id=?",
                "select r.id, n.snapshot_id as owner from frontend_routes r join graph_nodes n on n.id=r.node_id where r.snapshot_id=?",
                "select f.id, n.snapshot_id as owner from flows f join graph_nodes n on n.id=f.entry_node_id where f.snapshot_id=?",
                "select s.id, coalesce(n.snapshot_id, e.snapshot_id) as owner from flow_steps s join flows f on f.id=s.flow_id "
                        + "left join graph_nodes n on n.id=s.node_id left join graph_edges e on e.id=s.edge_id "
                        + "where f.snapshot_id=? and (s.node_id is not null or s.edge_id is not null)",
                "select a.id, n.snapshot_id as owner from analysis_findings a join graph_nodes n on n.id=a.node_id where a.snapshot_id=?")) {
            for (var row : jdbc.queryForList(projection, snapshot)) {
                if (((Number) row.get("owner")).longValue() != snapshot)
                    result.fail("projection references another snapshot");
                else result.count("projectionVerified");
            }
        }
        result.count("snapshotFiles" + "=" + fileRows.size());
        return result;
    }

    private Source source(
            long project, long user, long snapshot, String path, Map<String, Source> cache, Result result) {
        if (cache.containsKey(path)) return cache.get(path);
        Source source = null;
        try {
            var content = files.fileContent(project, user, path, snapshot);
            byte[] bytes = content.content().getBytes(StandardCharsets.UTF_8);
            String oid;
            try (var formatter = new ObjectInserter.Formatter()) {
                oid = formatter.idFor(Constants.OBJ_BLOB, bytes).name();
            }
            if (!oid.equals(content.contentOid())
                    || content.resolvedSnapshotId() != snapshot
                    || !"AVAILABLE".equals(content.sourceState())) {
                result.fail("served source identity " + path);
            } else source = new Source(bytes, lines(content.content()), oid);
        } catch (RuntimeException error) {
            result.fail("retained source unavailable " + path + " "
                    + error.getClass().getSimpleName());
        }
        cache.put(path, source);
        return source;
    }

    /** Lines split exactly like editors and the analyzers: LF, CRLF and lone CR terminate a line. */
    static List<String> lines(String text) {
        List<String> lines = new ArrayList<>();
        int start = 0;
        for (int index = 0; index < text.length(); index++) {
            char value = text.charAt(index);
            if (value == '\n' || value == '\r') {
                lines.add(text.substring(start, index));
                if (value == '\r' && index + 1 < text.length() && text.charAt(index + 1) == '\n') index++;
                start = index + 1;
            }
        }
        if (start < text.length()) lines.add(text.substring(start));
        return lines;
    }

    private static String span(Source source, int start, int end) {
        if (start < 1 || end < start || end > source.lines().size()) return null;
        return String.join("\n", source.lines().subList(start - 1, end));
    }

    private static boolean namespace(String type, String key, String path, Source source, Result result) {
        Matcher pathKey = PATH_KEY.matcher(key);
        if (pathKey.matches()) {
            if (!pathKey.group(2).equals(path)) {
                result.fail("natural key namespace " + key + " is not its file " + path);
                return false;
            }
            result.count("namespacePathVerified");
            return true;
        }
        Matcher javaKey = JAVA_KEY.matcher(key);
        if (javaKey.matches()) {
            String fqcn = javaKey.group(1);
            String text = new String(source.bytes(), StandardCharsets.UTF_8);
            if ("PACKAGE".equals(type)) {
                if (!Pattern.compile("(?m)^\\s*package\\s+" + Pattern.quote(fqcn) + "\\s*;")
                        .matcher(text)
                        .find()) {
                    result.fail("java package " + key + " is not declared in " + path);
                    return false;
                }
                result.count("namespaceJavaPackageVerified");
                return true;
            }
            int dot = fqcn.lastIndexOf('.');
            String declared = fqcn.substring(dot + 1).replaceAll("\\$.*", "");
            boolean packaged = dot < 0
                    ? !text.contains("package ")
                    : Pattern.compile("(?m)^\\s*package\\s+" + Pattern.quote(fqcn.substring(0, dot)) + "\\s*;")
                            .matcher(text)
                            .find();
            if (!packaged
                    || !Pattern.compile("\\b" + Pattern.quote(declared) + "\\b")
                            .matcher(text)
                            .find()) {
                result.fail("java namespace " + key + " is not declared in " + path);
                return false;
            }
            result.count("namespaceJavaPackageVerified");
            return true;
        }
        result.count("namespaceOther");
        return true;
    }

    private static boolean nameInSpan(String type, String name, String span) {
        if (name == null || name.isBlank()) return true;
        if (span.contains(name)) return true;
        Matcher endpoint = Pattern.compile("^[A-Z]+ (/\\S*)$").matcher(name);
        if ("API_ENDPOINT".equals(type) && endpoint.matches()) return span.contains("\"" + endpoint.group(1) + "\"");
        String simple = simpleName(name);
        return simple != null && span.contains(simple);
    }

    static String simpleName(String name) {
        if (name == null) return null;
        String value = name;
        int hash = value.lastIndexOf('#');
        if (hash >= 0) value = value.substring(hash + 1);
        int paren = value.indexOf('(');
        if (paren >= 0) value = value.substring(0, paren);
        int dot = value.lastIndexOf('.');
        if (dot >= 0) value = value.substring(dot + 1);
        Matcher matcher = IDENTIFIER.matcher(value);
        return matcher.find() ? matcher.group() : null;
    }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }
}
