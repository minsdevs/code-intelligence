package dev.codeintelligence.analysis.accuracy;

import dev.codeintelligence.analysis.accuracy.SemanticOracle.Fact;
import java.util.ArrayList;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;

/** Select only reviewed semantics; joins use IDs, but no ID ever enters an assertion or diagnostic. */
final class AccuracyFacts {
    private AccuracyFacts() {}

    static List<Fact> read(JdbcTemplate jdbc, long snapshot) {
        List<Fact> facts = new ArrayList<>();
        add(jdbc, snapshot, facts, """
                select 'node ' || n.natural_key as k,
                       n.node_type || case when n.node_type in ('METHOD','PACKAGE') then ''
                           else ' @' || coalesce(f.path, '<no-file>') end ||
                       case when n.node_type = 'FILE' and n.area_type = 'TESTING' then ' [TESTING]' else '' end as v
                from graph_nodes n left join files f on f.id = n.file_id
                where n.snapshot_id = ? and (
                    n.node_type in ('FILE','API_ENDPOINT','DB_ENTITY','DB_TABLE','MIGRATION',
                                    'FE_ROUTE','COMPONENT','HOOK','STORE')
                    or (n.natural_key like 'java:com.example.todo%'
                        and n.node_type in ('CLASS','INTERFACE','PACKAGE','METHOD')))
                """);
        add(jdbc, snapshot, facts, """
                select 'edge ' || e.edge_type || ' ' || s.natural_key || ' -> ' || t.natural_key as k,
                       e.confidence as v
                from graph_edges e
                join graph_nodes s on s.id = e.source_node_id
                join graph_nodes t on t.id = e.target_node_id
                left join files f on f.id = s.file_id
                where e.snapshot_id = ? and (
                    e.edge_type in ('CALLS','EXTENDS','EXPOSES','CONSUMES','MAPS_TO','READS_WRITES')
                    or (e.edge_type = 'DEPENDS_ON' and s.node_type = 'MIGRATION')
                    or (e.edge_type = 'DECLARES' and t.node_type = 'METHOD'
                        and s.natural_key like 'java:com.example.todo%')
                    or (e.edge_type = 'CONTAINS' and t.node_type in ('FE_ROUTE','COMPONENT','HOOK','STORE'))
                    or (e.edge_type = 'IMPORTS' and s.node_type = 'FILE' and f.path ~ '[.](tsx?|jsx?)$'))
                """);
        add(jdbc, snapshot, facts, """
                select 'endpoint ' || n.natural_key as k,
                       e.http_method || ' ' || e.path || ' | ' || e.handler_key as v
                from api_endpoints e join graph_nodes n on n.id = e.node_id where e.snapshot_id = ?
                """);
        add(jdbc, snapshot, facts, """
                select 'entity ' || n.natural_key as k,
                       e.entity_name || ' | ' || e.table_name || ' | ' || e.source as v
                from db_entities e join graph_nodes n on n.id = e.node_id where e.snapshot_id = ?
                """);
        add(jdbc, snapshot, facts, """
                select 'migration ' || natural_key as k, metadata->>'version' as v
                from graph_nodes where snapshot_id = ? and node_type = 'MIGRATION'
                """);
        add(jdbc, snapshot, facts, """
                select 'column ' || n.natural_key || '#' || (c->>'name') as k, lower(c->>'type') as v
                from graph_nodes n, jsonb_array_elements(n.metadata->'columns') c
                where n.snapshot_id = ? and n.node_type = 'DB_TABLE'
                """);
        add(jdbc, snapshot, facts, """
                select 'index ' || n.natural_key || '#' || i as k, '' as v
                from graph_nodes n, jsonb_array_elements_text(n.metadata->'indexes') i
                where n.snapshot_id = ? and n.node_type = 'DB_TABLE'
                """);
        add(jdbc, snapshot, facts, """
                select 'route ' || n.natural_key as k, r.path || ' | ' || coalesce(r.component_key, '<unresolved>') as v
                from frontend_routes r join graph_nodes n on n.id = r.node_id where r.snapshot_id = ?
                """);
        add(jdbc, snapshot, facts, """
                select 'api-call ' || n.natural_key || ' ' || (c->>'method') || ' ' || (c->>'url') as k, '' as v
                from graph_nodes n, jsonb_array_elements(n.metadata->'apiCalls') c where n.snapshot_id = ?
                """);
        facts.addAll(features(jdbc, snapshot));
        facts.addAll(findings(jdbc, snapshot));
        return facts;
    }

    static List<Fact> features(JdbcTemplate jdbc, long snapshot) {
        List<Fact> facts = new ArrayList<>();
        add(
                jdbc,
                snapshot,
                facts,
                "select 'feature ' || name as k, detection as v from features where snapshot_id = ?");
        add(jdbc, snapshot, facts, """
                select 'feature-link ' || f.name || ' -> ' || n.natural_key as k, l.role as v
                from feature_links l join features f on f.id = l.feature_id
                join graph_nodes n on n.id = l.node_id where f.snapshot_id = ?
                """);
        return facts;
    }

    static List<Fact> findings(JdbcTemplate jdbc, long snapshot) {
        List<Fact> facts = new ArrayList<>();
        add(jdbc, snapshot, facts, """
                select 'finding ' || f.category || ' ' || coalesce(n.natural_key, '<no-node>') as k, f.severity as v
                from analysis_findings f left join graph_nodes n on n.id = f.node_id where f.snapshot_id = ?
                """);
        return facts;
    }

    private static void add(JdbcTemplate jdbc, long snapshot, List<Fact> facts, String sql) {
        facts.addAll(
                jdbc.query(sql, (rs, row) -> new Fact(rs.getString("k"), String.valueOf(rs.getString("v"))), snapshot));
    }
}
