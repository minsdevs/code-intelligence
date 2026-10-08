package dev.codeintelligence.history;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.diff.DiffEntry;
import org.eclipse.jgit.diff.DiffFormatter;
import org.eclipse.jgit.diff.Edit;
import org.eclipse.jgit.diff.RawTextComparator;
import org.eclipse.jgit.errors.IncorrectObjectTypeException;
import org.eclipse.jgit.errors.MissingObjectException;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectReader;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.lib.Ref;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.patch.FileHeader;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.revwalk.RevSort;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.AbstractTreeIterator;
import org.eclipse.jgit.treewalk.CanonicalTreeParser;
import org.eclipse.jgit.treewalk.EmptyTreeIterator;
import org.eclipse.jgit.util.io.DisabledOutputStream;
import org.springframework.stereotype.Component;

/** Reads commits/branches/tags from a local clone only — never calls GitHub and never executes code. */
@Component
public class GitMetadataScanner {

    public GitMetadataScan scan(Path clonePath, int maxCommits) throws IOException {
        try (Git git = Git.open(clonePath.toFile())) {
            Repository repo = git.getRepository();
            List<ScannedRef> branches = listBranches(repo);
            List<ScannedRef> tags = listTags(repo);
            try (RevWalk walk = new RevWalk(repo);
                    ObjectReader reader = repo.newObjectReader();
                    DiffFormatter formatter = new DiffFormatter(DisabledOutputStream.INSTANCE)) {
                formatter.setRepository(repo);
                formatter.setDetectRenames(true);
                // Full object ids in the (discarded) patch headers: an abbreviated id is checked for
                // uniqueness by listing its loose-object directory, once per changed file, which made
                // the snapshot commit of a large project (every file added) quadratic in its files.
                formatter.setAbbreviationLength(Constants.OBJECT_ID_STRING_LENGTH);
                formatter.setDiffComparator(RawTextComparator.DEFAULT);
                walk.sort(RevSort.COMMIT_TIME_DESC, true);
                markStarts(repo, walk);
                List<ScannedCommit> commits = new ArrayList<>();
                int omitted = 0;
                for (RevCommit commit : walk) {
                    if (commits.size() >= maxCommits) {
                        omitted++;
                        continue;
                    }
                    commits.add(scanCommit(walk, reader, formatter, commit));
                }
                return new GitMetadataScan(List.copyOf(commits), branches, tags, omitted);
            }
        }
    }

    private static void markStarts(Repository repo, RevWalk walk) throws IOException {
        boolean any = false;
        any |= markPrefix(repo, walk, Constants.R_HEADS);
        any |= markPrefix(repo, walk, Constants.R_REMOTES);
        for (Ref ref : repo.getRefDatabase().getRefsByPrefix(Constants.R_TAGS)) {
            Ref peeled = repo.getRefDatabase().peel(ref);
            ObjectId id = peeled.getPeeledObjectId() != null ? peeled.getPeeledObjectId() : ref.getObjectId();
            if (id == null) {
                continue;
            }
            try {
                walk.markStart(walk.parseCommit(id));
                any = true;
            } catch (MissingObjectException | IncorrectObjectTypeException ignored) {
                // tag pointing at a non-commit object
            }
        }
        if (!any) {
            ObjectId head = repo.resolve(Constants.HEAD);
            if (head != null) {
                walk.markStart(walk.parseCommit(head));
            }
        }
    }

    private static boolean markPrefix(Repository repo, RevWalk walk, String prefix) throws IOException {
        boolean any = false;
        for (Ref ref : repo.getRefDatabase().getRefsByPrefix(prefix)) {
            if (ref.getName().endsWith("/HEAD")) {
                continue;
            }
            ObjectId id = ref.getObjectId();
            if (id == null) {
                continue;
            }
            walk.markStart(walk.parseCommit(id));
            any = true;
        }
        return any;
    }

    private static List<ScannedRef> listBranches(Repository repo) throws IOException {
        Map<String, ScannedRef> byName = new LinkedHashMap<>();
        for (Ref ref : repo.getRefDatabase().getRefsByPrefix(Constants.R_HEADS)) {
            if (ref.getObjectId() == null) {
                continue;
            }
            String name = ref.getName().substring(Constants.R_HEADS.length());
            byName.put(name, new ScannedRef(name, ref.getObjectId().name()));
        }
        String remotePrefix = Constants.R_REMOTES + Constants.DEFAULT_REMOTE_NAME + "/";
        for (Ref ref : repo.getRefDatabase().getRefsByPrefix(remotePrefix)) {
            if (ref.getObjectId() == null || ref.getName().endsWith("/HEAD")) {
                continue;
            }
            String name = ref.getName().substring(remotePrefix.length());
            byName.putIfAbsent(name, new ScannedRef(name, ref.getObjectId().name()));
        }
        return List.copyOf(byName.values());
    }

    private static List<ScannedRef> listTags(Repository repo) throws IOException {
        List<ScannedRef> tags = new ArrayList<>();
        for (Ref ref : repo.getRefDatabase().getRefsByPrefix(Constants.R_TAGS)) {
            Ref peeled = repo.getRefDatabase().peel(ref);
            ObjectId id = peeled.getPeeledObjectId() != null ? peeled.getPeeledObjectId() : ref.getObjectId();
            if (id == null) {
                continue;
            }
            String name = ref.getName().substring(Constants.R_TAGS.length());
            tags.add(new ScannedRef(name, id.name()));
        }
        return List.copyOf(tags);
    }

    private static ScannedCommit scanCommit(
            RevWalk walk, ObjectReader reader, DiffFormatter formatter, RevCommit commit) throws IOException {
        AbstractTreeIterator oldTree = oldTree(walk, reader, commit);
        CanonicalTreeParser newTree = new CanonicalTreeParser();
        newTree.reset(reader, commit.getTree());
        List<DiffEntry> diffs = formatter.scan(oldTree, newTree);
        int additions = 0;
        int deletions = 0;
        List<ScannedCommitFile> files = new ArrayList<>();
        for (DiffEntry entry : diffs) {
            LineStats stats = lineStats(formatter, entry);
            additions += stats.additions;
            deletions += stats.deletions;
            files.add(new ScannedCommitFile(pathOf(entry), entry.getChangeType().name()));
        }
        PersonIdent author = commit.getAuthorIdent();
        PersonIdent committer = commit.getCommitterIdent();
        Instant committedAt = committer == null ? Instant.EPOCH : committer.getWhenAsInstant();
        return new ScannedCommit(
                commit.getName(),
                formatAuthor(author),
                commit.getFullMessage(),
                committedAt,
                additions,
                deletions,
                List.copyOf(files));
    }

    private static AbstractTreeIterator oldTree(RevWalk walk, ObjectReader reader, RevCommit commit)
            throws IOException {
        if (commit.getParentCount() == 0) {
            return new EmptyTreeIterator();
        }
        RevCommit parent = walk.parseCommit(commit.getParent(0));
        CanonicalTreeParser parser = new CanonicalTreeParser();
        parser.reset(reader, parent.getTree());
        return parser;
    }

    private static LineStats lineStats(DiffFormatter formatter, DiffEntry entry) {
        try {
            FileHeader header = formatter.toFileHeader(entry);
            int additions = 0;
            int deletions = 0;
            for (Edit edit : header.toEditList()) {
                deletions += edit.getLengthA();
                additions += edit.getLengthB();
            }
            return new LineStats(additions, deletions);
        } catch (IOException ignored) {
            return new LineStats(0, 0);
        }
    }

    private static String pathOf(DiffEntry entry) {
        if (entry.getChangeType() == DiffEntry.ChangeType.DELETE) {
            return entry.getOldPath();
        }
        return entry.getNewPath();
    }

    private static String formatAuthor(PersonIdent ident) {
        if (ident == null) {
            return "";
        }
        String email = ident.getEmailAddress();
        if (email == null || email.isBlank()) {
            return ident.getName();
        }
        return ident.getName() + " <" + email + ">";
    }

    private record LineStats(int additions, int deletions) {}
}
