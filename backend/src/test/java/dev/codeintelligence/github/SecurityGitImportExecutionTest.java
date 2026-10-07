package dev.codeintelligence.github;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.common.AppProperties;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.CommitBuilder;
import org.eclipse.jgit.lib.Config;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.FileMode;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.lib.RefUpdate;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.lib.TreeFormatter;
import org.eclipse.jgit.storage.file.FileBasedConfig;
import org.eclipse.jgit.util.FS;
import org.eclipse.jgit.util.SystemReader;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * G-SEC source-execution boundary for GitHub import (05 §1: no submodule/LFS auto-tracking and no
 * credential helper/filter/hook execution). Repository content is hostile and the user's own Git
 * configuration may define filter drivers (for example the common {@code git lfs install} entries).
 * A file-system sentinel proves whether any external command ran during clone, fetch or reset.
 */
class SecurityGitImportExecutionTest {

    @TempDir
    Path temp;

    private SystemReader original;
    private GitCloneService service;
    private Path reposRoot;
    private Path sentinel;

    @BeforeEach
    void setUp() {
        original = SystemReader.getInstance();
        AppProperties properties = new AppProperties(temp.resolve("data").toString(), 2);
        reposRoot = properties.reposRoot();
        service = new GitCloneService(properties);
        sentinel = temp.resolve("executed-sentinel");
        // Fixture commits must never consult the developer's real Git configuration or drivers.
        installUserConfig("");
    }

    @AfterEach
    void restoreSystemReader() {
        SystemReader.setInstance(original);
    }

    @Test
    void userConfiguredSmudgeDriverSelectedByHostileAttributesNeverRunsOnCloneFetchOrReset() throws Exception {
        Path origin = workRepository("filters", Map.of(
                ".gitattributes", "* filter=evil\n*.bin filter=lfs diff=lfs merge=lfs -text\n",
                "README.md", "hello from a hostile repository\n",
                ".lfsconfig", "[lfs]\n\turl = http://127.0.0.1:9/attacker-lfs\n",
                "big.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:"
                        + "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n"));
        installUserConfig("[filter \"evil\"]\n\tsmudge = touch '" + sentinel + "-evil' ; cat\n\trequired = true\n"
                + "[filter \"lfs\"]\n\tsmudge = touch '" + sentinel + "-lfs' ; cat\n\tprocess = touch '"
                + sentinel + "-lfs-process'\n\trequired = true\n");

        Path target = reposRoot.resolve("11");
        service.cloneOrFetch(target, origin.toUri().toString(), null, null);

        assertNoCommandRan();
        assertThat(target.resolve("README.md")).hasContent("hello from a hostile repository");
        assertThat(Files.readString(target.resolve("big.bin"))).startsWith("version https://git-lfs.github.com/spec/v1");
        assertThat(target.resolve(".git/lfs")).doesNotExist();

        commit(origin, Map.of("second.txt", "fetched through the existing clone\n"));
        service.cloneOrFetch(target, origin.toUri().toString(), null, "main");

        assertNoCommandRan();
        assertThat(target.resolve("second.txt")).hasContent("fetched through the existing clone");
    }

    @Test
    void submodulesAreRecordedButNeverClonedOrCheckedOut() throws Exception {
        Path nested = workRepository("nested", Map.of("payload.txt", "submodule payload must stay remote\n"));
        Path origin = workRepository("outer", Map.of("README.md", "outer\n"));
        try (Git git = Git.open(origin.toFile())) {
            git.submoduleAdd().setPath("vendor/nested").setURI(nested.toUri().toString()).call().close();
            git.commit().setMessage("add submodule").setAuthor(ident()).setCommitter(ident()).call();
        }
        installUserConfig("");

        Path target = reposRoot.resolve("12");
        service.cloneOrFetch(target, origin.toUri().toString(), null, null);

        assertThat(target.resolve(".gitmodules")).exists();
        assertThat(target.resolve(".git/modules")).doesNotExist();
        assertThat(target.resolve("vendor/nested/payload.txt")).doesNotExist();
        try (var children = Files.list(target.resolve("vendor/nested"))) {
            assertThat(children).isEmpty();
        }
    }

    @Test
    void treeEntriesTargetingTheGitDirectoryCannotPlantHooksOrConfiguration() throws Exception {
        Path bare = temp.resolve("planted.git");
        try (Repository repository = Git.init().setBare(true).setDirectory(bare.toFile()).call().getRepository()) {
            ObjectId hostileConfig = blob(repository, "[core]\n\thooksPath = " + temp + "\n[filter \"x\"]\n\tsmudge = touch '"
                    + sentinel + "-config'\n");
            ObjectId hook = blob(repository, "#!/bin/sh\ntouch '" + sentinel + "-hook'\n");
            ObjectId readme = blob(repository, "inert readme\n");
            ObjectId hooks = tree(repository, Map.of("post-checkout", new Entry(FileMode.EXECUTABLE_FILE, hook)));
            ObjectId dotGit = tree(repository, Map.of(
                    "config", new Entry(FileMode.REGULAR_FILE, hostileConfig),
                    "hooks", new Entry(FileMode.TREE, hooks)));
            ObjectId root = tree(repository, Map.of(
                    ".GIT", new Entry(FileMode.TREE, dotGit),
                    "README.md", new Entry(FileMode.REGULAR_FILE, readme),
                    "hooks", new Entry(FileMode.TREE, hooks)));
            updateMain(repository, root);
        }
        installUserConfig("");

        Path target = reposRoot.resolve("13");
        // JGit's checkout path check refuses the reserved name. Failing closed is acceptable;
        // planting a hook/config or running a command is not.
        assertThatThrownBy(() -> service.cloneOrFetch(target, bare.toUri().toString(), null, null))
                .isInstanceOfAny(GitCloneException.class, org.eclipse.jgit.dircache.InvalidPathException.class);

        assertNoCommandRan();
        assertThat(target.resolve(".git/hooks/post-checkout")).doesNotExist();
        Path config = target.resolve(".git/config");
        if (Files.exists(config)) {
            assertThat(Files.readString(config)).doesNotContain("hooksPath").doesNotContain("smudge");
        }
    }

    @Test
    void cloneRefusesRepositoryStorageOutsideItsRootEvenForHostileRemoteNames() {
        installUserConfig("");
        assertThatThrownBy(() -> service.cloneOrFetch(
                        reposRoot.resolve("14/../../escape"), temp.resolve("missing").toUri().toString(), null, null))
                .isInstanceOf(GitCloneException.class);
        assertThat(temp.resolve("escape")).doesNotExist();
    }

    private void assertNoCommandRan() throws Exception {
        try (var siblings = Files.list(temp)) {
            assertThat(siblings.map(path -> path.getFileName().toString()))
                    .as("no filter, hook or helper command may run while importing hostile Git content")
                    .noneMatch(name -> name.startsWith(sentinel.getFileName().toString()));
        }
    }

    /** Models a user-level Git configuration; system configuration is empty so the test spawns nothing itself. */
    private void installUserConfig(String content) {
        Path userConfig = temp.resolve("user.gitconfig");
        Path systemConfig = temp.resolve("system.gitconfig");
        try {
            Files.writeString(userConfig, content, StandardCharsets.UTF_8);
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
        SystemReader.setInstance(new SystemReader.Delegate(original) {
            @Override
            public FileBasedConfig openUserConfig(Config parent, FS fs) {
                return new FileBasedConfig(parent, userConfig.toFile(), fs);
            }

            @Override
            public FileBasedConfig openSystemConfig(Config parent, FS fs) {
                return new FileBasedConfig(parent, systemConfig.toFile(), fs);
            }

            @Override
            public FileBasedConfig openJGitConfig(Config parent, FS fs) {
                return new FileBasedConfig(parent, temp.resolve("jgit.config").toFile(), fs);
            }
        });
    }

    private Path workRepository(String name, Map<String, String> files) throws Exception {
        Path directory = temp.resolve("origin-" + name);
        try (Git git = Git.init().setDirectory(directory.toFile()).setInitialBranch("main").call()) {
            for (var file : files.entrySet()) {
                Path path = directory.resolve(file.getKey());
                Files.createDirectories(path.getParent());
                Files.writeString(path, file.getValue(), StandardCharsets.UTF_8);
            }
            git.add().addFilepattern(".").call();
            git.commit().setMessage("hostile fixture").setAuthor(ident()).setCommitter(ident()).call();
        }
        return directory;
    }

    private void commit(Path directory, Map<String, String> files) throws Exception {
        try (Git git = Git.open(directory.toFile())) {
            for (var file : files.entrySet()) {
                Files.writeString(directory.resolve(file.getKey()), file.getValue(), StandardCharsets.UTF_8);
            }
            git.add().addFilepattern(".").call();
            git.commit().setMessage("follow-up").setAuthor(ident()).setCommitter(ident()).call();
        }
    }

    private static PersonIdent ident() {
        return new PersonIdent("Synthetic Fixture", "fixture@example.invalid");
    }

    private record Entry(FileMode mode, ObjectId id) {}

    private static ObjectId blob(Repository repository, String content) throws Exception {
        try (ObjectInserter inserter = repository.newObjectInserter()) {
            ObjectId id = inserter.insert(Constants.OBJ_BLOB, content.getBytes(StandardCharsets.UTF_8));
            inserter.flush();
            return id;
        }
    }

    private static ObjectId tree(Repository repository, Map<String, Entry> entries) throws Exception {
        TreeFormatter formatter = new TreeFormatter();
        entries.entrySet().stream()
                .sorted((left, right) -> treeOrder(left.getKey(), left.getValue().mode())
                        .compareTo(treeOrder(right.getKey(), right.getValue().mode())))
                .forEach(entry -> formatter.append(entry.getKey(), entry.getValue().mode(), entry.getValue().id()));
        try (ObjectInserter inserter = repository.newObjectInserter()) {
            ObjectId id = inserter.insert(formatter);
            inserter.flush();
            return id;
        }
    }

    private static String treeOrder(String name, FileMode mode) {
        return mode == FileMode.TREE ? name + "/" : name;
    }

    private static void updateMain(Repository repository, ObjectId tree) throws Exception {
        CommitBuilder commit = new CommitBuilder();
        commit.setTreeId(tree);
        commit.setAuthor(ident());
        commit.setCommitter(ident());
        commit.setMessage("planted git directory entries");
        ObjectId id;
        try (ObjectInserter inserter = repository.newObjectInserter()) {
            id = inserter.insert(commit);
            inserter.flush();
        }
        RefUpdate update = repository.updateRef("refs/heads/main");
        update.setNewObjectId(id);
        update.setForceUpdate(true);
        assertThat(update.update()).isIn(RefUpdate.Result.NEW, RefUpdate.Result.FORCED);
        RefUpdate head = repository.updateRef(Constants.HEAD);
        head.link("refs/heads/main");
    }
}
