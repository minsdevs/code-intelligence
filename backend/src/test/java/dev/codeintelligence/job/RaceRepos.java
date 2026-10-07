package dev.codeintelligence.job;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.transport.RefSpec;
import org.springframework.util.FileSystemUtils;

/** Local bare repositories with a small Java/TypeScript/config project; no network access. */
final class RaceRepos {

    private static final PersonIdent IDENT = new PersonIdent("fixture", "fixture@test.local");

    static final String SERVICE = "src/main/java/demo/ItemService.java";
    static final String CONTROLLER = "src/main/java/demo/ItemController.java";
    static final String APP = "web/src/App.tsx";

    private RaceRepos() {}

    /** First revision: controller -> service call, a React page calling the endpoint, configs. */
    static Map<String, String> initialFiles(String marker) {
        Map<String, String> files = new LinkedHashMap<>();
        files.put("README.md", "race fixture " + marker + "\n");
        files.put("pom.xml", """
                <project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>race</artifactId>
                <version>1</version><dependencies><dependency><groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-starter-web</artifactId><version>3.3.0</version></dependency>
                </dependencies></project>
                """);
        files.put(CONTROLLER, """
                package demo;

                import org.springframework.web.bind.annotation.GetMapping;
                import org.springframework.web.bind.annotation.RestController;

                @RestController
                public class ItemController {
                    private final ItemService service = new ItemService();

                    @GetMapping("/api/items")
                    public String items() {
                        return service.load();
                    }
                }
                """);
        files.put(SERVICE, """
                package demo;

                public class ItemService {
                    public String load() {
                        return "%s";
                    }
                }
                """.formatted(marker));
        files.put("package.json", """
                {"name":"race-web","version":"1.0.0","dependencies":{"react":"18.2.0","react-dom":"18.2.0"}}
                """);
        files.put(APP, """
                export async function loadItems(): Promise<string> {
                  const response = await fetch('/api/items');
                  return response.text();
                }
                export default function App() { return null; }
                """);
        files.put("Dockerfile", "FROM eclipse-temurin:21\nCOPY target/app.jar /app.jar\n");
        return files;
    }

    static Path create(Path originRoot, String owner, String name, Map<String, String> files) throws Exception {
        Path bare = originRoot.resolve(owner).resolve(name + ".git");
        Files.createDirectories(bare);
        Git.init()
                .setBare(true)
                .setInitialBranch("main")
                .setDirectory(bare.toFile())
                .call()
                .close();
        Path work = Files.createTempDirectory("race-fixture-init");
        try (Git git =
                Git.init().setInitialBranch("main").setDirectory(work.toFile()).call()) {
            write(work, files);
            git.add().addFilepattern(".").call();
            commit(git, "initial commit");
            git.push()
                    .setRemote(bare.toUri().toString())
                    .setRefSpecs(new RefSpec("refs/heads/main:refs/heads/main"))
                    .call();
        } finally {
            FileSystemUtils.deleteRecursively(work);
        }
        return bare;
    }

    /** Applies writes (null value deletes) as one new commit on main; returns the new sha. */
    static String commit(Path bare, Map<String, String> changes, String message) throws Exception {
        Path work = Files.createTempDirectory("race-fixture-commit");
        try (Git git = Git.cloneRepository()
                .setURI(bare.toUri().toString())
                .setDirectory(work.toFile())
                .call()) {
            for (Map.Entry<String, String> change : changes.entrySet()) {
                if (change.getValue() == null) {
                    git.rm().addFilepattern(change.getKey()).call();
                } else {
                    write(work, Map.of(change.getKey(), change.getValue()));
                    git.add().addFilepattern(change.getKey()).call();
                }
            }
            String sha = commit(git, message);
            git.push().call();
            return sha;
        } finally {
            FileSystemUtils.deleteRecursively(work);
        }
    }

    private static String commit(Git git, String message) throws Exception {
        RevCommit commit = git.commit()
                .setMessage(message)
                .setAuthor(IDENT)
                .setCommitter(IDENT)
                .setSign(false)
                .setAllowEmpty(true)
                .call();
        return commit.getName();
    }

    private static void write(Path root, Map<String, String> files) throws Exception {
        for (Map.Entry<String, String> file : files.entrySet()) {
            Path target = root.resolve(file.getKey());
            Files.createDirectories(target.getParent());
            Files.writeString(target, file.getValue());
        }
    }
}
