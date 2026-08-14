package dev.codeintelligence.testsupport;

import java.io.IOException;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.stream.Stream;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.api.errors.GitAPIException;
import org.eclipse.jgit.lib.PersonIdent;

public final class FixtureRepo {

    private static final PersonIdent IDENT = new PersonIdent("fixture", "fixture@test.local");

    private FixtureRepo() {}

    public static Path create(String name) throws IOException, GitAPIException, URISyntaxException {
        Path dest = Files.createTempDirectory("ci-fixture-" + name + "-");
        copyInto(name, dest);
        gitInit(dest, name);
        return dest;
    }

    public static Path create(String name, Path dest) throws IOException, GitAPIException, URISyntaxException {
        Files.createDirectories(dest);
        copyInto(name, dest);
        gitInit(dest, name);
        return dest;
    }

    private static void copyInto(String name, Path dest) throws IOException, URISyntaxException {
        URL resource = FixtureRepo.class.getResource("/fixtures/" + name);
        if (resource == null) {
            throw new IllegalArgumentException("unknown fixture: " + name);
        }
        Path source = Path.of(resource.toURI());
        try (Stream<Path> walk = Files.walk(source)) {
            walk.forEach(from -> {
                try {
                    Path to = dest.resolve(source.relativize(from).toString());
                    if (Files.isDirectory(from)) {
                        Files.createDirectories(to);
                    } else {
                        Files.createDirectories(to.getParent());
                        Files.copy(from, to, StandardCopyOption.REPLACE_EXISTING);
                    }
                } catch (IOException e) {
                    throw new IllegalStateException(e);
                }
            });
        }
    }

    private static void gitInit(Path dest, String name) throws GitAPIException, IOException {
        try (Git git =
                Git.init().setInitialBranch("main").setDirectory(dest.toFile()).call()) {
            try (Stream<Path> walk = Files.walk(dest)) {
                walk.filter(Files::isRegularFile).forEach(file -> {
                    if (file.startsWith(dest.resolve(".git"))) {
                        return;
                    }
                    String rel = dest.relativize(file).toString().replace('\\', '/');
                    try {
                        git.add().addFilepattern(rel).call();
                    } catch (GitAPIException e) {
                        throw new IllegalStateException(e);
                    }
                });
            }
            git.commit()
                    .setMessage("fixture " + name)
                    .setAuthor(IDENT)
                    .setCommitter(IDENT)
                    .setSign(false)
                    .call();
        }
    }
}
