package dev.codeintelligence.analysis.accuracy;

import dev.codeintelligence.analysis.accuracy.SemanticOracle.Fact;
import dev.codeintelligence.analysis.accuracy.SemanticOracle.Ignored;
import java.util.ArrayList;
import java.util.List;

/**
 * Hand-authored from the checked-in fixture declarations and SpringMiniGraph/EndpointsFeatures,
 * ReactMiniTsParsing, ConfigAnalyzers and FullstackCrossDomain golden tests. Never regenerate this
 * from analyzer output. Unlisted facts IN THE SELECTED SCOPE are unexpected and fail the gate.
 */
final class FixtureAccuracyOracle {
    static final String JAVA = "java:com.example.todo.";
    static final String ENTITY = "entity:com.example.todo.domain.Todo";
    static final String MIGRATIONS = "src/main/resources/db/migration/";

    // Intentionally outside this gate: dependency/config/infra extraction (existing config goldens),
    // external classpath stubs, annotations, Java imports/USES_TYPE and non-method DECLARES edges.
    // [검증 필요] these three fixtures cannot establish their precision/recall on real repositories.
    // Allowed variation: IDs, timestamps, row order, evidence text/line offsets, package provenance,
    // and inherited method stub provenance. Method keys and CALLS confidence ARE checked exactly.
    static final List<String> SCOPE_NOTES = List.of(
            "허용 가능한 변동: DB ID, timestamp, 순서, line/evidence text, package/inherited-method provenance",
            "[검증 필요] oracle 범위 밖: external stubs, Java IMPORTS/USES_TYPE/annotations, config/infra, dynamic routing",
            "[검증 필요] 실제 private/public 저장소 정확도, real-backend browser E2E, backup/restore, production 승인");

    private final List<Fact> facts = new ArrayList<>();

    static List<Fact> expected(String fixture) {
        FixtureAccuracyOracle oracle = new FixtureAccuracyOracle();
        if (!fixture.equals("react-mini")) {
            oracle.spring(fixture.equals("fullstack-mini") ? "backend/" : "");
        }
        if (!fixture.equals("spring-mini")) {
            oracle.react(fixture.equals("fullstack-mini") ? "frontend/" : "");
        }
        if (fixture.equals("fullstack-mini")) {
            oracle.file("docker-compose.yml", false);
            oracle.file(".github/workflows/ci.yml", false);
            // /api/todos vs /todos is ONLY a suffix heuristic: the fixture declares no proxy rewrite.
            // POSSIBLE is justified; a CONFIRMED match would be an accuracy regression.
            oracle.edge(
                    "CONSUMES",
                    "component:frontend/src/pages/TodosPage.tsx#TodosPage",
                    "endpoint:GET:/todos",
                    "POSSIBLE");
            oracle.edge("CONSUMES", "route:/todos", "endpoint:GET:/todos", "POSSIBLE");
            oracle.link("todos", "component:frontend/src/pages/TodosPage.tsx#TodosPage", "UI");
        }
        return List.copyOf(oracle.facts);
    }

    static List<Ignored> ignored(String fixture) {
        return fixture.equals("react-mini")
                ? List.of(new Ignored(
                        new Fact("finding UNMATCHED_API_CALL component:src/pages/TodosPage.tsx#TodosPage", "MEDIUM"),
                        "oracle 불명확 [검증 필요]: frontend-only fixture has no backend; this does not prove a broken API"))
                : List.of();
    }

    private void spring(String prefix) {
        String src = prefix + "src/main/java/com/example/todo/";
        for (String config : List.of("build.gradle", "settings.gradle", "src/main/resources/application.yml")) {
            file(prefix + config, false);
        }
        for (String type : List.of(
                "TodoApplication",
                "api/AuthController",
                "api/TodoController",
                "domain/Todo",
                "repository/TodoRepository",
                "service/AuthService",
                "service/TodoService")) {
            String path = src + type + ".java";
            file(path, false);
            node(type.endsWith("Repository") ? "INTERFACE" : "CLASS", JAVA + type.replace('/', '.'), path);
        }
        String testPath = prefix + "src/test/java/com/example/todo/TodoServiceTest.java";
        file(testPath, true);
        node("CLASS", JAVA + "TodoServiceTest", testPath);
        for (String pkg : List.of("", ".api", ".domain", ".repository", ".service")) {
            fact("node java:com.example.todo" + pkg, "PACKAGE");
        }
        // Constructors use their declared Java name. Repository methods are inherited call targets.
        methods("TodoApplication", "main(java.lang.String[])");
        methods("api.AuthController", "AuthController(com.example.todo.service.AuthService)", "login()", "logout()");
        methods(
                "api.TodoController",
                "TodoController(com.example.todo.service.TodoService)",
                "list()",
                "get(java.lang.Long)",
                "create(com.example.todo.domain.Todo)");
        methods(
                "domain.Todo",
                "getId()",
                "setId(java.lang.Long)",
                "getTitle()",
                "setTitle(java.lang.String)",
                "isDone()",
                "setDone(boolean)");
        methods("service.AuthService", "login()", "logout()");
        methods(
                "service.TodoService",
                "TodoService(com.example.todo.repository.TodoRepository)",
                "findAll()",
                "findById(java.lang.Long)",
                "create(com.example.todo.domain.Todo)");
        methods(
                "repository.TodoRepository",
                "findAll()",
                "findById(java.lang.Long)",
                "save(com.example.todo.domain.Todo)");
        methods("TodoServiceTest", "placeholder()");
        edge(
                "EXTENDS",
                JAVA + "repository.TodoRepository",
                "java:org.springframework.data.jpa.repository.JpaRepository",
                "CONFIRMED");
        call("api.AuthController#login()", "service.AuthService#login()", "CONFIRMED");
        call("api.AuthController#logout()", "service.AuthService#logout()", "CONFIRMED");
        call("api.TodoController#list()", "service.TodoService#findAll()", "CONFIRMED");
        call("api.TodoController#get(java.lang.Long)", "service.TodoService#findById(java.lang.Long)", "CONFIRMED");
        call(
                "api.TodoController#create(com.example.todo.domain.Todo)",
                "service.TodoService#create(com.example.todo.domain.Todo)",
                "CONFIRMED");
        call("service.TodoService#findAll()", "repository.TodoRepository#findAll()", "POSSIBLE");
        call(
                "service.TodoService#findById(java.lang.Long)",
                "repository.TodoRepository#findById(java.lang.Long)",
                "POSSIBLE");
        call(
                "service.TodoService#create(com.example.todo.domain.Todo)",
                "repository.TodoRepository#save(com.example.todo.domain.Todo)",
                "POSSIBLE");
        endpoint(src, "POST", "/auth/login", "AuthController", "login()", "auth");
        endpoint(src, "POST", "/auth/logout", "AuthController", "logout()", "auth");
        endpoint(src, "GET", "/todos", "TodoController", "list()", "todos");
        endpoint(src, "GET", "/todos/{id}", "TodoController", "get(java.lang.Long)", "todos");
        endpoint(src, "POST", "/todos", "TodoController", "create(com.example.todo.domain.Todo)", "todos");
        node("DB_ENTITY", ENTITY, src + "domain/Todo.java");
        fact("entity " + ENTITY, "Todo | todos | JPA");
        node("DB_TABLE", "table:todos", prefix + MIGRATIONS + "V1__create_todos.sql");
        fact("column table:todos#id", "bigserial");
        fact("column table:todos#title", "text");
        fact("column table:todos#done", "boolean");
        fact("index table:todos#idx_todos_done", "");
        int version = 0;
        for (String name : List.of("V1__create_todos.sql", "V2__add_todos_done_index.sql")) {
            String path = prefix + MIGRATIONS + name;
            file(path, false);
            node("MIGRATION", "migration:" + path, path);
            fact("migration migration:" + path, String.valueOf(++version));
            edge("DEPENDS_ON", "migration:" + path, "table:todos", "CONFIRMED");
        }
        edge("MAPS_TO", ENTITY, "table:todos", "CONFIRMED");
        edge("READS_WRITES", JAVA + "repository.TodoRepository", "table:todos", "LIKELY");
        fact("feature auth", "STATIC");
        fact("feature todos", "STATIC");
        link("auth", JAVA + "api.AuthController", "API");
        link("auth", JAVA + "service.AuthService", "SERVICE");
        link("todos", JAVA + "api.TodoController", "API");
        link("todos", JAVA + "service.TodoService", "SERVICE");
        link("todos", JAVA + "repository.TodoRepository", "DATA");
        link("todos", JAVA + "domain.Todo", "DATA");
        link("todos", ENTITY, "DATA");
    }

    private void react(String prefix) {
        for (String path : List.of(
                "index.html",
                "package.json",
                "tsconfig.json",
                "vite.config.ts",
                "src/main.tsx",
                "src/App.tsx",
                "src/pages/HomePage.tsx",
                "src/pages/TodosPage.tsx",
                "src/components/TodoItem.tsx")) {
            file(prefix + path, false);
        }
        file(prefix + "src/components/TodoItem.test.tsx", true);
        for (String component : List.of("App", "pages/HomePage", "pages/TodosPage", "components/TodoItem")) {
            String path = prefix + "src/" + component + ".tsx";
            String name = component.substring(component.lastIndexOf('/') + 1);
            String key = "component:" + path + "#" + name;
            node("COMPONENT", key, path);
            edge("CONTAINS", "file:" + path, key, "CONFIRMED");
        }
        route(prefix, "/", "HomePage");
        route(prefix, "/todos", "TodosPage");
        fact("api-call component:" + prefix + "src/pages/TodosPage.tsx#TodosPage GET /api/todos", "");
        imports(prefix, "src/main.tsx", "src/App.tsx");
        imports(prefix, "src/App.tsx", "src/pages/HomePage.tsx");
        imports(prefix, "src/App.tsx", "src/pages/TodosPage.tsx");
        imports(prefix, "src/pages/TodosPage.tsx", "src/components/TodoItem.tsx");
        // Test imports remain structural evidence; the test must never become a feature/UI link.
        imports(prefix, "src/components/TodoItem.test.tsx", "src/components/TodoItem.tsx");
        if (prefix.isEmpty()) {
            fact("feature todos", "STATIC");
        }
        link("todos", "route:/todos", "UI");
        // No ORPHAN_ROUTE for '/' (static page) or '/todos' (resolved component).
        // No extra test-file feature, component or API call. Exact-set comparison rejects them all.
    }

    private void endpoint(String src, String method, String path, String owner, String handler, String feature) {
        String key = "endpoint:" + method + ":" + path;
        node("API_ENDPOINT", key, src + "api/" + owner + ".java");
        fact("endpoint " + key, method + " " + path + " | " + JAVA + "api." + owner + "#" + handler);
        edge("EXPOSES", JAVA + "api." + owner, key, "CONFIRMED");
        link(feature, key, "API");
    }

    private void methods(String owner, String... signatures) {
        for (String signature : signatures) {
            String key = JAVA + owner + "#" + signature;
            fact("node " + key, "METHOD");
            edge("DECLARES", JAVA + owner, key, "CONFIRMED");
        }
    }

    private void route(String prefix, String path, String component) {
        node("FE_ROUTE", "route:" + path, prefix + "src/App.tsx");
        fact("route route:" + path, path + " | " + component);
        edge("CONTAINS", "file:" + prefix + "src/App.tsx", "route:" + path, "CONFIRMED");
        edge(
                "CONTAINS",
                "route:" + path,
                "component:" + prefix + "src/pages/" + component + ".tsx#" + component,
                "LIKELY");
    }

    private void imports(String prefix, String from, String to) {
        edge("IMPORTS", "file:" + prefix + from, "file:" + prefix + to, "CONFIRMED");
    }

    private void call(String from, String to, String confidence) {
        edge("CALLS", JAVA + from, JAVA + to, confidence);
    }

    private void link(String feature, String node, String role) {
        fact("feature-link " + feature + " -> " + node, role);
    }

    private void edge(String type, String from, String to, String confidence) {
        fact("edge " + type + " " + from + " -> " + to, confidence);
    }

    private void file(String path, boolean testing) {
        fact("node file:" + path, "FILE @" + path + (testing ? " [TESTING]" : ""));
    }

    private void node(String type, String key, String path) {
        fact("node " + key, type + " @" + path);
    }

    private void fact(String key, String value) {
        facts.add(new Fact(key, value));
    }
}
