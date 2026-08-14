package dev.codeintelligence.ai;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

@Component
public class EvidenceValidator {

    private static final Pattern FILE = Pattern.compile("^file:([^:]+):(\\d+)$");
    private static final Pattern COMMIT = Pattern.compile("^commit:([a-fA-F0-9]{7,40})$");
    private static final Pattern PR = Pattern.compile("^pr:(\\d+)$");

    private final JdbcClient jdbc;

    public EvidenceValidator(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public AIProvider.ChatResponse validate(long projectId, long snapshotId, AIProvider.ChatResponse response) {
        List<AIProvider.Claim> claims = new ArrayList<>();
        for (AIProvider.Claim claim : response.claims()) {
            List<String> kept = new ArrayList<>();
            for (String ref : claim.evidence()) {
                if (exists(projectId, snapshotId, ref)) {
                    kept.add(ref);
                }
            }
            String confidence =
                    claim.confidence() == null ? "UNKNOWN" : claim.confidence().toUpperCase(Locale.ROOT);
            if (kept.isEmpty()) {
                confidence = "UNKNOWN";
            }
            claims.add(new AIProvider.Claim(claim.text(), confidence, List.copyOf(kept)));
        }
        return new AIProvider.ChatResponse(
                response.raw(),
                List.copyOf(claims),
                response.explanation(),
                response.alternatives(),
                response.promptTokens(),
                response.completionTokens());
    }

    public Set<String> collectRefs(AIProvider.ChatResponse response) {
        Set<String> refs = new LinkedHashSet<>();
        for (AIProvider.Claim claim : response.claims()) {
            refs.addAll(claim.evidence());
        }
        return refs;
    }

    boolean exists(long projectId, long snapshotId, String raw) {
        if (raw == null || raw.isBlank()) {
            return false;
        }
        String ref = raw.strip();
        Matcher file = FILE.matcher(ref);
        if (file.matches()) {
            String path = file.group(1);
            int line = Integer.parseInt(file.group(2));
            Boolean ok = jdbc.sql("""
                            select exists(
                                select 1 from files
                                where snapshot_id = :snapshotId
                                  and path = :path
                                  and (line_count is null or line_count >= :line)
                            )
                            """)
                    .param("snapshotId", snapshotId)
                    .param("path", path)
                    .param("line", line)
                    .query(Boolean.class)
                    .single();
            return Boolean.TRUE.equals(ok);
        }
        Matcher commit = COMMIT.matcher(ref);
        if (commit.matches()) {
            String sha = commit.group(1).toLowerCase(Locale.ROOT);
            Boolean ok = jdbc.sql("""
                            select exists(
                                select 1 from commits
                                where project_id = :projectId and lower(sha) like :prefix
                            )
                            """)
                    .param("projectId", projectId)
                    .param("prefix", sha + "%")
                    .query(Boolean.class)
                    .single();
            return Boolean.TRUE.equals(ok);
        }
        Matcher pr = PR.matcher(ref);
        if (pr.matches()) {
            long number = Long.parseLong(pr.group(1));
            Boolean ok = jdbc.sql("""
                            select exists(
                                select 1 from pull_requests
                                where project_id = :projectId and number = :number
                            )
                            """)
                    .param("projectId", projectId)
                    .param("number", number)
                    .query(Boolean.class)
                    .single();
            return Boolean.TRUE.equals(ok);
        }
        return false;
    }
}
