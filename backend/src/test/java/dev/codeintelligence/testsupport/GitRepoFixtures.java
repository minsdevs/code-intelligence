package dev.codeintelligence.testsupport;

import java.nio.file.Files;
import java.nio.file.Path;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.transport.RefSpec;
import org.springframework.util.FileSystemUtils;

/** Local bare-repo fixtures so clone/fetch tests never touch the network. */
public final class GitRepoFixtures {

    private static final PersonIdent IDENT = new PersonIdent("fixture", "fixture@test.local");

    private GitRepoFixtures() {}

    /** Creates {@code {originRoot}/{owner}/{name}.git} with one commit on main; returns its sha. */
    public static String createBareRepoWithCommit(Path originRoot, String owner, String name) throws Exception {
        Path bare = originRoot.resolve(owner).resolve(name + ".git");
        Files.createDirectories(bare);
        Git.init()
                .setBare(true)
                .setInitialBranch("main")
                .setDirectory(bare.toFile())
                .call()
                .close();

        Path work = Files.createTempDirectory("git-fixture-init");
        try (Git git =
                Git.init().setInitialBranch("main").setDirectory(work.toFile()).call()) {
            Files.writeString(work.resolve("README.md"), "fixture " + owner + "/" + name);
            git.add().addFilepattern(".").call();
            RevCommit commit = git.commit()
                    .setMessage("initial commit")
                    .setAuthor(IDENT)
                    .setCommitter(IDENT)
                    .setSign(false)
                    .call();
            git.push()
                    .setRemote(bare.toUri().toString())
                    .setRefSpecs(new RefSpec("refs/heads/main:refs/heads/main"))
                    .call();
            return commit.getName();
        } finally {
            FileSystemUtils.deleteRecursively(work);
        }
    }

    /** Adds one commit to an existing bare repo's main branch; returns the new sha. */
    public static String addCommit(Path bareRepo, String fileName, String content) throws Exception {
        Path work = Files.createTempDirectory("git-fixture-commit");
        try (Git git = Git.cloneRepository()
                .setURI(bareRepo.toUri().toString())
                .setDirectory(work.toFile())
                .call()) {
            Files.writeString(work.resolve(fileName), content);
            git.add().addFilepattern(".").call();
            RevCommit commit = git.commit()
                    .setMessage("add " + fileName)
                    .setAuthor(IDENT)
                    .setCommitter(IDENT)
                    .setSign(false)
                    .call();
            git.push().call();
            return commit.getName();
        } finally {
            FileSystemUtils.deleteRecursively(work);
        }
    }
}
