package dev.codeintelligence.history;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.testsupport.GitMetadataFixtures;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class GitMetadataScannerTest {

    @TempDir
    Path dir;

    private final GitMetadataScanner scanner = new GitMetadataScanner();

    @Test
    void collectsCommitsBranchesTagsAndRename() throws Exception {
        GitMetadataFixtures.GoldenRepo golden = GitMetadataFixtures.createGolden(dir);

        GitMetadataScan scan = scanner.scan(dir, 10_000);

        assertThat(scan.omittedCommitCount()).isZero();
        assertThat(scan.commits()).hasSize(5);
        assertThat(scan.commits())
                .extracting(ScannedCommit::sha)
                .containsExactly(golden.c5(), golden.c4(), golden.c3(), golden.c2(), golden.c1());
        assertThat(scan.commits())
                .extracting(ScannedCommit::message)
                .containsExactly("c5 rename b", "c4 add b", "c3 grow a", "c2 add a", "c1 initial");
        assertThat(scan.commits()).extracting(ScannedCommit::author).containsOnly("Ada <ada@test.local>");

        ScannedCommit initial = scan.commits().get(4);
        assertThat(initial.files()).containsExactly(new ScannedCommitFile("README.md", "ADD"));
        assertThat(initial.additions()).isEqualTo(1);
        assertThat(initial.deletions()).isZero();

        ScannedCommit addA = scan.commits().get(3);
        assertThat(addA.files()).containsExactly(new ScannedCommitFile("src/a.txt", "ADD"));
        assertThat(addA.additions()).isEqualTo(2);

        ScannedCommit growA = scan.commits().get(2);
        assertThat(growA.files()).containsExactly(new ScannedCommitFile("src/a.txt", "MODIFY"));
        assertThat(growA.additions()).isEqualTo(1);
        assertThat(growA.deletions()).isZero();

        ScannedCommit addB = scan.commits().get(1);
        assertThat(addB.files()).containsExactly(new ScannedCommitFile("src/b.txt", "ADD"));
        assertThat(addB.additions()).isEqualTo(1);

        ScannedCommit rename = scan.commits().get(0);
        assertThat(rename.files()).containsExactly(new ScannedCommitFile("src/renamed.txt", "RENAME"));
        assertThat(rename.additions()).isZero();
        assertThat(rename.deletions()).isZero();

        assertThat(scan.branches()).extracting(ScannedRef::name).containsExactlyInAnyOrder("main", "topic");
        assertThat(scan.branches())
                .filteredOn(ref -> ref.name().equals("main"))
                .extracting(ScannedRef::headSha)
                .containsExactly(golden.c5());
        assertThat(scan.branches())
                .filteredOn(ref -> ref.name().equals("topic"))
                .extracting(ScannedRef::headSha)
                .containsExactly(golden.c4());
        assertThat(scan.tags()).containsExactly(new ScannedRef("v1.0", golden.c3()));
    }

    @Test
    void truncatesNewestFirstAndCountsOmitted() throws Exception {
        GitMetadataFixtures.createGolden(dir);

        GitMetadataScan scan = scanner.scan(dir, 2);

        assertThat(scan.commits()).hasSize(2);
        assertThat(scan.omittedCommitCount()).isEqualTo(3);
        assertThat(scan.commits()).extracting(ScannedCommit::message).containsExactly("c5 rename b", "c4 add b");
    }
}
