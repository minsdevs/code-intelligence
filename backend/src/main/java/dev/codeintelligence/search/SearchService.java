package dev.codeintelligence.search;

import dev.codeintelligence.ai.SummaryService;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

@Service
public class SearchService {

    public record SearchHit(String type, long projectId, long id, String title, String snippet, String path) {}

    public record SearchGroup(String type, List<SearchHit> hits) {}

    public record SearchResponse(String query, List<SearchGroup> groups) {}

    private static final int PER_TYPE = 8;
    private static final int QUERY_MAX = 200;

    private final JdbcClient jdbc;
    private final SummaryService summaryService;

    public SearchService(JdbcClient jdbc, SummaryService summaryService) {
        this.jdbc = jdbc;
        this.summaryService = summaryService;
    }

    @Transactional(readOnly = true)
    public SearchResponse search(long userId, Long projectId, String rawQuery) {
        String query = rawQuery == null ? "" : rawQuery.strip();
        if (!StringUtils.hasText(query) || query.length() > QUERY_MAX) {
            throw new InvalidSearchQueryException();
        }
        if (projectId != null) {
            Boolean owned = jdbc.sql("select exists(select 1 from projects where id = :id and user_id = :userId)")
                    .param("id", projectId)
                    .param("userId", userId)
                    .query(Boolean.class)
                    .single();
            if (!Boolean.TRUE.equals(owned)) {
                return new SearchResponse(query, List.of());
            }
        }
        String like = contains(query);
        Map<String, List<SearchHit>> grouped = new LinkedHashMap<>();
        add(grouped, "FILE", files(userId, projectId, query, like));
        add(grouped, "SYMBOL", symbols(userId, projectId, query, like));
        add(grouped, "FEATURE", features(userId, projectId, query, like));
        add(grouped, "FLOW", flows(userId, projectId, query, like));
        add(grouped, "COMMIT", commits(userId, projectId, query, like));
        add(grouped, "PR", pulls(userId, projectId, query, like));
        add(grouped, "FINDING", findings(userId, projectId, query, like));
        add(grouped, "NOTE", notes(userId, projectId, query, like));
        add(grouped, "TASK", tasks(userId, projectId, query, like));
        add(grouped, "EVIDENCE", evidence(userId, projectId, query, like));
        add(grouped, "SUMMARY", summaries(userId, projectId, query));
        List<SearchGroup> groups = new ArrayList<>();
        grouped.forEach((type, hits) -> {
            if (!hits.isEmpty()) {
                groups.add(new SearchGroup(type, List.copyOf(hits)));
            }
        });
        return new SearchResponse(query, List.copyOf(groups));
    }

    private List<SearchHit> files(long userId, Long projectId, String query, String like) {
        return jdbc.sql("""
                        select 'FILE' as type, p.id as project_id, f.id, f.path as title, f.language as snippet, f.path
                        from files f
                        join snapshots s on s.id = f.snapshot_id
                        join projects p on p.id = s.project_id and p.current_snapshot_id = s.id
                        where p.user_id = :userId
                          and (:projectId::bigint is null or p.id = :projectId)
                          and (f.path ilike :like escape '\\'
                               or to_tsvector('simple', f.path) @@ plainto_tsquery('simple', :query))
                        order by similarity(f.path, :query) desc nulls last, f.id
                        limit :limit
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("like", like)
                .param("query", query)
                .param("limit", PER_TYPE)
                .query(this::hit)
                .list();
    }

    private List<SearchHit> symbols(long userId, Long projectId, String query, String like) {
        return jdbc.sql("""
                        select 'SYMBOL' as type, p.id as project_id, n.id, n.name as title,
                               coalesce(f.path, n.node_type) as snippet, f.path
                        from graph_nodes n
                        join snapshots s on s.id = n.snapshot_id
                        join projects p on p.id = s.project_id and p.current_snapshot_id = s.id
                        left join files f on f.id = n.file_id
                        where p.user_id = :userId
                          and (:projectId::bigint is null or p.id = :projectId)
                          and n.node_type not in ('FILE', 'DIRECTORY')
                          and (n.name ilike :like escape '\\'
                               or to_tsvector('simple', n.name) @@ plainto_tsquery('simple', :query))
                        order by similarity(n.name, :query) desc nulls last, n.id
                        limit :limit
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("like", like)
                .param("query", query)
                .param("limit", PER_TYPE)
                .query(this::hit)
                .list();
    }

    private List<SearchHit> features(long userId, Long projectId, String query, String like) {
        return jdbc.sql("""
                        select 'FEATURE' as type, p.id as project_id, feat.id, feat.name as title,
                               coalesce(feat.description, '') as snippet, null as path
                        from features feat
                        join snapshots s on s.id = feat.snapshot_id
                        join projects p on p.id = s.project_id and p.current_snapshot_id = s.id
                        where p.user_id = :userId
                          and (:projectId::bigint is null or p.id = :projectId)
                          and (feat.name ilike :like escape '\\'
                               or to_tsvector('simple', coalesce(feat.name,'') || ' ' || coalesce(feat.description,''))
                                  @@ plainto_tsquery('simple', :query))
                        order by feat.id
                        limit :limit
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("like", like)
                .param("query", query)
                .param("limit", PER_TYPE)
                .query(this::hit)
                .list();
    }

    private List<SearchHit> flows(long userId, Long projectId, String query, String like) {
        return jdbc.sql("""
                        select 'FLOW' as type, p.id as project_id, fl.id, fl.name as title, fl.kind as snippet, null as path
                        from flows fl
                        join snapshots s on s.id = fl.snapshot_id
                        join projects p on p.id = s.project_id and p.current_snapshot_id = s.id
                        where p.user_id = :userId
                          and (:projectId::bigint is null or p.id = :projectId)
                          and (fl.name ilike :like escape '\\'
                               or to_tsvector('simple', fl.name) @@ plainto_tsquery('simple', :query))
                        order by fl.id
                        limit :limit
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("like", like)
                .param("query", query)
                .param("limit", PER_TYPE)
                .query(this::hit)
                .list();
    }

    private List<SearchHit> commits(long userId, Long projectId, String query, String like) {
        return jdbc.sql("""
                        select 'COMMIT' as type, p.id as project_id, c.id, left(c.sha, 10) as title,
                               left(c.message, 160) as snippet, null as path
                        from commits c
                        join projects p on p.id = c.project_id
                        where p.user_id = :userId
                          and (:projectId::bigint is null or p.id = :projectId)
                          and (c.sha ilike :like escape '\\'
                               or c.message ilike :like escape '\\'
                               or to_tsvector('simple', coalesce(c.message,'')) @@ plainto_tsquery('simple', :query))
                        order by c.committed_at desc nulls last
                        limit :limit
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("like", like)
                .param("query", query)
                .param("limit", PER_TYPE)
                .query(this::hit)
                .list();
    }

    private List<SearchHit> pulls(long userId, Long projectId, String query, String like) {
        return jdbc.sql("""
                        select 'PR' as type, p.id as project_id, pr.id, coalesce(pr.title, '#' || pr.number) as title,
                               pr.state as snippet, null as path
                        from pull_requests pr
                        join projects p on p.id = pr.project_id
                        where p.user_id = :userId
                          and (:projectId::bigint is null or p.id = :projectId)
                          and (pr.title ilike :like escape '\\'
                               or to_tsvector('simple', coalesce(pr.title,'')) @@ plainto_tsquery('simple', :query))
                        order by pr.number desc
                        limit :limit
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("like", like)
                .param("query", query)
                .param("limit", PER_TYPE)
                .query(this::hit)
                .list();
    }

    private List<SearchHit> findings(long userId, Long projectId, String query, String like) {
        return jdbc.sql("""
                        select 'FINDING' as type, p.id as project_id, f.id, f.title,
                               coalesce(f.severity || ' ' || f.category, '') as snippet, null as path
                        from analysis_findings f
                        join snapshots s on s.id = f.snapshot_id
                        join projects p on p.id = s.project_id and p.current_snapshot_id = s.id
                        where p.user_id = :userId
                          and (:projectId::bigint is null or p.id = :projectId)
                          and (f.title ilike :like escape '\\'
                               or to_tsvector('simple', coalesce(f.title,'') || ' ' || coalesce(f.detail,''))
                                  @@ plainto_tsquery('simple', :query))
                        order by f.id
                        limit :limit
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("like", like)
                .param("query", query)
                .param("limit", PER_TYPE)
                .query(this::hit)
                .list();
    }

    private List<SearchHit> notes(long userId, Long projectId, String query, String like) {
        return jdbc.sql("""
                        select 'NOTE' as type, p.id as project_id, n.id, n.title,
                               left(n.content_md, 160) as snippet, null as path
                        from notes n
                        join projects p on p.id = n.project_id
                        where p.user_id = :userId
                          and (:projectId::bigint is null or p.id = :projectId)
                          and (n.title ilike :like escape '\\' or n.content_md ilike :like escape '\\'
                               or to_tsvector('simple', coalesce(n.title,'') || ' ' || coalesce(n.content_md,''))
                                  @@ plainto_tsquery('simple', :query))
                        order by n.updated_at desc
                        limit :limit
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("like", like)
                .param("query", query)
                .param("limit", PER_TYPE)
                .query(this::hit)
                .list();
    }

    private List<SearchHit> tasks(long userId, Long projectId, String query, String like) {
        return jdbc.sql("""
                        select 'TASK' as type, p.id as project_id, t.id, t.title,
                               t.type || ' ' || t.status as snippet, null as path
                        from tasks t
                        join projects p on p.id = t.project_id
                        where p.user_id = :userId
                          and (:projectId::bigint is null or p.id = :projectId)
                          and t.status <> 'DRAFT' and t.type <> 'LEARNING'
                          and (t.title ilike :like escape '\\' or t.description ilike :like escape '\\'
                               or to_tsvector('simple', coalesce(t.title,'') || ' ' || coalesce(t.description,''))
                                  @@ plainto_tsquery('simple', :query))
                        order by t.updated_at desc
                        limit :limit
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("like", like)
                .param("query", query)
                .param("limit", PER_TYPE)
                .query(this::hit)
                .list();
    }

    private List<SearchHit> evidence(long userId, Long projectId, String query, String like) {
        return jdbc.sql("""
                        select 'EVIDENCE' as type, p.id as project_id, e.id, coalesce(e.file_path, e.kind) as title,
                               left(e.excerpt, 160) as snippet, e.file_path as path
                        from evidences e
                        join projects p on p.id = e.project_id
                        where p.user_id = :userId
                          and (:projectId::bigint is null or p.id = :projectId)
                          and (e.file_path ilike :like escape '\\' or e.excerpt ilike :like escape '\\')
                        order by e.id desc
                        limit :limit
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .param("like", like)
                .param("query", query)
                .param("limit", PER_TYPE)
                .query(this::hit)
                .list();
    }

    private List<SearchHit> summaries(long userId, Long projectId, String query) {
        if (!StringUtils.hasText(query)) {
            return List.of();
        }
        List<Long> snapshotIds = jdbc.sql("""
                        select p.current_snapshot_id
                        from projects p
                        where p.user_id = :userId
                          and p.current_snapshot_id is not null
                          and (:projectId::bigint is null or p.id = :projectId)
                        """)
                .param("userId", userId)
                .param("projectId", projectId)
                .query(Long.class)
                .list();
        List<SearchHit> hits = new ArrayList<>();
        for (Long snapshotId : snapshotIds) {
            if (hits.size() >= PER_TYPE) {
                break;
            }
            Long project = jdbc.sql("select project_id from snapshots where id = :id")
                    .param("id", snapshotId)
                    .query(Long.class)
                    .optional()
                    .orElse(null);
            if (project == null) {
                continue;
            }
            for (String content : summaryService.similar(userId, snapshotId, query, 3)) {
                hits.add(new SearchHit("SUMMARY", project, snapshotId, "Summary", content, null));
                if (hits.size() >= PER_TYPE) {
                    break;
                }
            }
        }
        return hits;
    }

    private SearchHit hit(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new SearchHit(
                rs.getString("type"),
                rs.getLong("project_id"),
                rs.getLong("id"),
                rs.getString("title"),
                rs.getString("snippet"),
                rs.getString("path"));
    }

    private static void add(Map<String, List<SearchHit>> grouped, String type, List<SearchHit> hits) {
        if (!hits.isEmpty()) {
            grouped.put(type, hits);
        }
    }

    private static String contains(String query) {
        return "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
    }
}
