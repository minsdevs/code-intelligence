package dev.codeintelligence.history;

import java.util.List;

public record GitMetadataScan(
        List<ScannedCommit> commits, List<ScannedRef> branches, List<ScannedRef> tags, int omittedCommitCount) {}
