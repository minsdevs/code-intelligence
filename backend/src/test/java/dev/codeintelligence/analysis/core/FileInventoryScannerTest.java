package dev.codeintelligence.analysis.core;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.dircache.DirCache;
import org.eclipse.jgit.dircache.DirCacheBuilder;
import org.eclipse.jgit.dircache.DirCacheEntry;
import org.eclipse.jgit.lib.FileMode;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.PersonIdent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class FileInventoryScannerTest {

    private static final PersonIdent IDENT = new PersonIdent("fixture", "fixture@test.local");

    @TempDir
    Path dir;

    @Test
    void skipsBinaryAndOversizedFiles() throws Exception {
        Files.writeString(dir.resolve("hello.txt"), "hello\nworld\n");
        Files.write(dir.resolve("blob.bin"), new byte[] {0x00, 0x01, 0x02});
        Files.write(dir.resolve("huge.txt"), "x".repeat(200).getBytes(StandardCharsets.UTF_8));
        try (Git git =
                Git.init().setInitialBranch("main").setDirectory(dir.toFile()).call()) {
            git.add().addFilepattern(".").call();
            git.commit()
                    .setMessage("init")
                    .setAuthor(IDENT)
                    .setCommitter(IDENT)
                    .setSign(false)
                    .call();
        }

        InventoryResult result = new FileInventoryScanner().scan(dir, 20_000, 50);

        assertThat(result.files()).extracting(InventoriedFile::path).containsExactly("hello.txt");
        assertThat(result.files().getFirst().language()).isNull();
        assertThat(result.files().getFirst().lineCount()).isEqualTo(2);
        assertThat(result.skippedBinary()).isEqualTo(1);
        assertThat(result.skippedForSize()).isEqualTo(1);
        assertThat(result.skippedForCount()).isZero();
    }

    @Test
    void missingSubmoduleCommitDoesNotAbortParentInventory() throws Exception {
        Files.writeString(dir.resolve("main.ts"), "export const app = 1;\n");
        try (Git git =
                Git.init().setInitialBranch("main").setDirectory(dir.toFile()).call()) {
            git.add().addFilepattern(".").call();
            DirCache cache = git.getRepository().lockDirCache();
            try {
                DirCacheBuilder builder = cache.builder();
                builder.add(cache.getEntry("main.ts"));
                DirCacheEntry submodule = new DirCacheEntry("vendor/library");
                submodule.setFileMode(FileMode.GITLINK);
                submodule.setObjectId(ObjectId.fromString("1111111111111111111111111111111111111111"));
                builder.add(submodule);
                assertThat(builder.commit()).isTrue();
            } finally {
                cache.unlock();
            }
            git.commit()
                    .setMessage("parent with unavailable submodule")
                    .setAuthor(IDENT)
                    .setCommitter(IDENT)
                    .setSign(false)
                    .call();
        }
        InventoryResult result = new FileInventoryScanner().scan(dir, 20_000, 1_000_000);
        assertThat(result.files()).extracting(InventoriedFile::path).containsExactly("main.ts");
        assertThat(result.skippedSubmodules()).isEqualTo(1);
    }

    @Test
    void emptyHeadYieldsNoFiles() throws Exception {
        Git.init().setInitialBranch("main").setDirectory(dir.toFile()).call().close();
        InventoryResult result = new FileInventoryScanner().scan(dir, 20_000, 1_000_000);
        assertThat(result.files()).isEmpty();
    }
}
