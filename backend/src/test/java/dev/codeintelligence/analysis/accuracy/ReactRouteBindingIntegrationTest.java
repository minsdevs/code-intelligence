package dev.codeintelligence.analysis.accuracy;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.TestcontainersConfiguration;
import dev.codeintelligence.analysis.config.ExtractionStep;
import dev.codeintelligence.analysis.core.FileInventoryStep;
import dev.codeintelligence.analysis.cross.CrossDomainStep;
import dev.codeintelligence.analysis.graph.GraphBuildStep;
import dev.codeintelligence.analysis.graph.SourceParsingStep;
import dev.codeintelligence.analysis.ts.TsParsingStep;
import dev.codeintelligence.testsupport.TestJobContext;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import org.eclipse.jgit.api.Git;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** Real sidecar -> HTTP DTO -> graph mapper -> PostgreSQL; run in the explicit accuracyTest task. */
@SpringBootTest(
        properties = {"app.token-enc-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", "logging.level.root=WARN"})
@Import(TestcontainersConfiguration.class)
class ReactRouteBindingIntegrationTest {
    @TempDir
    static Path directory;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        String url = System.getProperty("accuracy.ts-url", "");
        if (!url.matches("http://127\\.0\\.0\\.1:[0-9]+")) {
            throw new IllegalStateException("The real local accuracy analyzer is required; no fake fallback.");
        }
        registry.add("app.data-dir", () -> directory.resolve("data").toString());
        registry.add("app.ts-analyzer.base-url", () -> url);
    }

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    FileInventoryStep inventory;

    @Autowired
    SourceParsingStep source;

    @Autowired
    GraphBuildStep graph;

    @Autowired
    TsParsingStep typescript;

    @Autowired
    ExtractionStep extraction;

    @Autowired
    CrossDomainStep cross;

    @Test
    void defaultImportAliasLinksOnlyTheActualExportedDeclaration() throws Exception {
        long snapshot = analyze(Map.of(
                "ui/Router.tsx", """
                    import { Route } from 'react-router-dom';
                    import Selected from './Page';
                    export function Router() { return <Route path="/detail" element={<Selected />} /> }
                    """,
                "ui/Page.tsx", "export default function ActualPage() { return <h1>detail</h1> }",
                "admin/Page.tsx", "export default function Selected() { return <h1>unrelated</h1> }"));
        assertThat(routeTargets(snapshot))
                .containsExactly("route:/detail -> component:ui/Page.tsx#ActualPage @ui/Page.tsx LIKELY");
    }

    @Test
    void valueExportAliasesAndConstDefaultsResolveWhileTypeOnlyMissingAndShadowedBindingsStayUnlinked()
            throws Exception {
        long snapshot = analyze(Map.of(
                "ui/Router.tsx", """
                    import { Route } from 'react-router-dom';
                    import Chosen from './Page';
                    import { default as Named } from './Page';
                    import type OnlyType from './Page';
                    import Missing from './NoDefault';
                    export function Router() { return <>
                      <Route path="/chosen" element={<Chosen/>}/>
                      <Route path="/named" element={<Named></Named>}/>
                      <Route path="/type" element={<OnlyType/>}/>
                      <Route path="/missing" element={<Missing/>}/>
                    </> }
                    export function Shadow(Chosen: any) { return <Route path="/shadow" element={<Chosen/>}/> }
                    """,
                "ui/Page.tsx", "const ActualPage = () => <h1>detail</h1>; export { ActualPage as default };",
                "ui/NoDefault.tsx", "export function Missing() { return <h1>not a default</h1> }"));
        assertThat(routeTargets(snapshot))
                .containsExactly(
                        "route:/chosen -> component:ui/Page.tsx#ActualPage @ui/Page.tsx LIKELY",
                        "route:/named -> component:ui/Page.tsx#ActualPage @ui/Page.tsx LIKELY");
    }

    @Test
    void downstreamApiPropagationUsesTheResolvedEdgeInsteadOfGlobalDisplayNames() throws Exception {
        long snapshot = analyze(Map.of(
                "ui/Router.tsx", """
                    import { Route } from 'react-router-dom';
                    import Selected from './Page';
                    export function Router() { return <Route path="/selected" element={<Selected/>}/> }
                    export function Shadow(Selected: any) { return <Route path="/shadow" element={<Selected/>}/> }
                    """,
                "ui/Page.tsx", "export default function ActualPage() { fetch('/selected-api'); return <h1/> }",
                "admin/Page.tsx", "export function Selected() { fetch('/wrong-api'); return <h1/> }"));
        long project = jdbc.queryForObject("select project_id from snapshots where id=?", Long.class, snapshot);
        for (String path : java.util.List.of("/selected-api", "/wrong-api")) {
            long node = jdbc.queryForObject("""
                    insert into graph_nodes(snapshot_id,node_type,natural_key,name)
                    values (?,'API_ENDPOINT',?,?) returning id
                    """, Long.class, snapshot, "endpoint:GET:" + path, path);
            jdbc.update("""
                    insert into api_endpoints(snapshot_id,node_id,http_method,path,handler_key)
                    values (?,?,'GET',?,'synthetic-handler')
                    """, snapshot, node, path);
        }
        Path clone = Path.of(jdbc.queryForObject("select clone_path from projects where id=?", String.class, project));
        var context = new TestJobContext(1, project, snapshot, clone);
        cross.run(context);
        cross.run(context);
        assertThat(jdbc.queryForList("""
                select s.natural_key || ' -> ' || t.natural_key
                from graph_edges e join graph_nodes s on s.id=e.source_node_id
                join graph_nodes t on t.id=e.target_node_id
                where e.snapshot_id=? and s.node_type='FE_ROUTE' and e.edge_type='CONSUMES'
                order by s.natural_key,t.natural_key
                """, String.class, snapshot))
                .containsExactly("route:/selected -> endpoint:GET:/selected-api");
        assertThat(routeTargets(snapshot))
                .containsExactly("route:/selected -> component:ui/Page.tsx#ActualPage @ui/Page.tsx LIKELY");

        // Simulate a retried interpretation on the same snapshot. The old binding
        // and derived API edge must be revoked, not left behind by upsert-only storage.
        Files.writeString(clone.resolve("ui/Router.tsx"), """
                import { Route } from 'react-router-dom';
                import Selected from './Page';
                export function Router(Selected: any) { return <Route path="/selected" element={<Selected/>}/> }
                """);
        typescript.run(context);
        extraction.run(context);
        cross.run(context);
        assertThat(routeTargets(snapshot)).isEmpty();
        assertThat(jdbc.queryForObject("""
                select count(*) from graph_edges e join graph_nodes s on s.id=e.source_node_id
                where e.snapshot_id=? and s.node_type='FE_ROUTE' and e.edge_type='CONSUMES'
                """, Long.class, snapshot)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from api_endpoints where snapshot_id=?", Long.class, snapshot))
                .isEqualTo(2);
    }

    @Test
    void duplicateRouteDeclarationsCannotKeepTheFirstResolvedBinding() throws Exception {
        long snapshot = analyze(Map.of("ui/Router.tsx", """
                import { Route } from 'react-router-dom';
                function Selected() { return <h1/> }
                export function One() { return <Route path="/detail" element={<Selected/>}/> }
                export function Two(Selected: any) { return <Route path="/detail" element={<Selected/>}/> }
                """));
        assertThat(routeTargets(snapshot)).isEmpty();
        assertThat(jdbc.queryForObject("""
                select metadata->>'componentResolution' from graph_nodes
                where snapshot_id=? and natural_key='route:/detail'
                """, String.class, snapshot)).isEqualTo("UNRESOLVED");
    }

    @Test
    void barePackageEntryHeuristicsCannotCreateAWrongComponentEdge() throws Exception {
        long snapshot = analyze(Map.of(
                "ui/Router.tsx", """
                    import { Route } from 'react-router-dom';
                    import Selected from '@fixture/ui';
                    export function Router() { return <Route path="/detail" element={<Selected/>}/> }
                    """,
                "pkg/package.json", "{\"name\":\"@fixture/ui\",\"exports\":\"./src/Actual.tsx\"}",
                "pkg/src/index.tsx", "export default function WrongPage() { return <h1/> }",
                "pkg/src/Actual.tsx", "export default function ActualPage() { return <h2/> }"));
        assertThat(routeTargets(snapshot)).isEmpty();
        assertThat(jdbc.queryForObject("""
                select metadata->>'componentResolution' from graph_nodes
                where snapshot_id=? and natural_key='route:/detail'
                """, String.class, snapshot)).isEqualTo("UNRESOLVED");
    }

    private java.util.List<String> routeTargets(long snapshot) {
        return jdbc.queryForList("""
                select s.natural_key || ' -> ' || t.natural_key || ' @' || f.path || ' ' || e.confidence
                from graph_edges e join graph_nodes s on s.id=e.source_node_id
                join graph_nodes t on t.id=e.target_node_id join files f on f.id=t.file_id
                where e.snapshot_id=? and s.node_type='FE_ROUTE' and t.node_type='COMPONENT'
                order by s.natural_key,t.natural_key
                """, String.class, snapshot);
    }

    private long analyze(Map<String, String> files) throws Exception {
        String id = UUID.randomUUID().toString();
        long user = jdbc.queryForObject(
                "insert into users(login,identity_type,local_key) values (?,'LOCAL',?) returning id",
                Long.class,
                "route-" + id,
                "route-fixture-" + id);
        long project = jdbc.queryForObject("""
                insert into projects(user_id,name,repo_owner,repo_name)
                values (?,'route binding','fixture',?) returning id
                """, Long.class, user, id);
        Path clone = directory.resolve("data/repos").resolve(Long.toString(project));
        for (var file : files.entrySet()) {
            Path destination = clone.resolve(file.getKey());
            Files.createDirectories(destination.getParent());
            Files.writeString(destination, file.getValue());
        }
        String commit;
        try (var git =
                Git.init().setInitialBranch("main").setDirectory(clone.toFile()).call()) {
            git.add().addFilepattern(".").call();
            commit = git.commit()
                    .setMessage("Synthetic route binding fixture")
                    .setAuthor("Fixture", "fixture@example.invalid")
                    .setCommitter("Fixture", "fixture@example.invalid")
                    .setSign(false)
                    .call()
                    .name();
        }
        jdbc.update("update projects set clone_path=? where id=?", clone.toString(), project);
        long snapshot = jdbc.queryForObject("""
                insert into snapshots(project_id,commit_sha,status)
                values (?,?,'ANALYZING') returning id
                """, Long.class, project, commit);
        var context = new TestJobContext(1, project, snapshot, clone);
        inventory.run(context);
        source.run(context);
        graph.run(context);
        typescript.run(context);
        extraction.run(context);
        return snapshot;
    }
}
