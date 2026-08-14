package dev.codeintelligence.testsupport;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneOffset;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.revwalk.RevCommit;

/** Local git histories for Git metadata collection tests (no network). */
public final class GitMetadataFixtures {

    public static final PersonIdent AUTHOR =
            new PersonIdent("Ada", "ada@test.local", Instant.parse("2026-01-01T00:00:00Z"), ZoneOffset.UTC);

    private GitMetadataFixtures() {}

    /**
     * Five commits on {@code main}, a {@code topic} branch at commit 4, and tag {@code v1.0} at
     * commit 3. Commit 5 renames {@code src/b.txt} → {@code src/renamed.txt}.
     */
    public static GoldenRepo createGolden(Path dir) throws Exception {
        Files.createDirectories(dir);
        try (Git git =
                Git.init().setInitialBranch("main").setDirectory(dir.toFile()).call()) {
            RevCommit c1 = commit(git, dir, 0, "c1 initial", "README.md", "line1\n");
            RevCommit c2 = commit(git, dir, 1, "c2 add a", "src/a.txt", "one\ntwo\n");
            Files.writeString(dir.resolve("src/a.txt"), "one\ntwo\nthree\n");
            git.add().addFilepattern("src/a.txt").call();
            RevCommit c3 = commitMessage(git, 2, "c3 grow a");
            git.tag().setName("v1.0").setObjectId(c3).call();
            RevCommit c4 = commit(git, dir, 3, "c4 add b", "src/b.txt", "beta\n");
            git.branchCreate().setName("topic").setStartPoint(c4).call();
            Files.writeString(dir.resolve("src/renamed.txt"), "beta\n");
            git.add().addFilepattern("src/renamed.txt").call();
            git.rm().addFilepattern("src/b.txt").call();
            RevCommit c5 = commitMessage(git, 4, "c5 rename b");
            return new GoldenRepo(c1.getName(), c2.getName(), c3.getName(), c4.getName(), c5.getName());
        }
    }

    private static RevCommit commit(Git git, Path dir, int hourOffset, String message, String relative, String content)
            throws Exception {
        Path file = dir.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, content);
        git.add().addFilepattern(relative).call();
        return commitMessage(git, hourOffset, message);
    }

    private static RevCommit commitMessage(Git git, int hourOffset, String message) throws Exception {
        PersonIdent ident = new PersonIdent(
                AUTHOR, Instant.parse("2026-01-01T00:00:00Z").plusSeconds(hourOffset * 3600L), ZoneOffset.UTC);
        return git.commit()
                .setMessage(message)
                .setAuthor(ident)
                .setCommitter(ident)
                .setSign(false)
                .call();
    }

    public record GoldenRepo(String c1, String c2, String c3, String c4, String c5) {}
}
