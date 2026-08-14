package dev.codeintelligence.history;

import dev.codeintelligence.analysis.core.FileTooLargeException;
import dev.codeintelligence.analysis.core.InvalidFilePathException;
import dev.codeintelligence.analysis.core.SafeRelativePath;
import dev.codeintelligence.common.AnalysisProperties;
import dev.codeintelligence.common.AppProperties;
import dev.codeintelligence.project.Project;
import dev.codeintelligence.project.ProjectNotFoundException;
import dev.codeintelligence.project.ProjectRepository;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.diff.DiffEntry;
import org.eclipse.jgit.diff.DiffFormatter;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectLoader;
import org.eclipse.jgit.lib.ObjectReader;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.revwalk.RevSort;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.AbstractTreeIterator;
import org.eclipse.jgit.treewalk.CanonicalTreeParser;
import org.eclipse.jgit.treewalk.EmptyTreeIterator;
import org.eclipse.jgit.util.io.DisabledOutputStream;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

@Service
public class HistoryService {

    static final int PAGE_SIZE = 50;

    private final ProjectRepository projectRepository;
    private final JdbcClient jdbc;
    private final AppProperties appProperties;
    private final AnalysisProperties analysisProperties;

    public HistoryService(
            ProjectRepository projectRepository,
            JdbcClient jdbc,
            AppProperties appProperties,
            AnalysisProperties analysisProperties) {
        this.projectRepository = projectRepository;
        this.jdbc = jdbc;
        this.appProperties = appProperties;
        this.analysisProperties = analysisProperties;
    }

    @Transactional(readOnly = true)
    public List<CommitSummary> listCommits(long projectId, long userId, Integer page, String branch) {
        Project project = requireOwned(projectId, userId);
        int resolvedPage = page == null || page < 1 ? 1 : page;
        if (StringUtils.hasText(branch)) {
            return listCommitsOnBranch(project, branch, resolvedPage);
        }
        int offset = (resolvedPage - 1) * PAGE_SIZE;
        return jdbc.sql("""
                        select sha, author, message, committed_at, additions, deletions
                        from commits
                        where project_id = :projectId
                        order by committed_at desc, sha
                        limit :limit offset :offset
                        """)
                .param("projectId", projectId)
                .param("limit", PAGE_SIZE)
                .param("offset", offset)
                .query((rs, rowNum) -> new CommitSummary(
                        rs.getString("sha"),
                        rs.getString("author"),
                        rs.getString("message"),
                        toInstant(rs.getObject("committed_at", OffsetDateTime.class)),
                        rs.getInt("additions"),
                        rs.getInt("deletions")))
                .list();
    }

    @Transactional(readOnly = true)
    public CommitDetail commitDetail(long projectId, long userId, String sha) {
        requireOwned(projectId, userId);
        CommitDetail header = jdbc.sql("""
                        select sha, author, message, committed_at, additions, deletions
                        from commits
                        where project_id = :projectId and sha = :sha
                        """)
                .param("projectId", projectId)
                .param("sha", sha)
                .query((rs, rowNum) -> new CommitDetail(
                        rs.getString("sha"),
                        rs.getString("author"),
                        rs.getString("message"),
                        toInstant(rs.getObject("committed_at", OffsetDateTime.class)),
                        rs.getInt("additions"),
                        rs.getInt("deletions"),
                        new ArrayList<>()))
                .optional()
                .orElseThrow(CommitNotFoundException::new);
        List<CommitFileView> files = jdbc.sql("""
                        select f.path, f.change_type
                        from commit_files f
                        join commits c on c.id = f.commit_id
                        where c.project_id = :projectId and c.sha = :sha
                        order by f.path
                        """)
                .param("projectId", projectId)
                .param("sha", sha)
                .query((rs, rowNum) -> new CommitFileView(rs.getString("path"), rs.getString("change_type")))
                .list();
        return new CommitDetail(
                header.sha(),
                header.author(),
                header.message(),
                header.committedAt(),
                header.additions(),
                header.deletions(),
                files);
    }

    @Transactional(readOnly = true)
    public CommitDiff diff(long projectId, long userId, String sha, String path) {
        String normalized = SafeRelativePath.normalize(path);
        Project project = requireOwned(projectId, userId);
        boolean exists = jdbc.sql("select 1 from commits where project_id = :projectId and sha = :sha")
                .param("projectId", projectId)
                .param("sha", sha)
                .query(Integer.class)
                .optional()
                .isPresent();
        if (!exists) {
            throw new CommitNotFoundException();
        }
        Path clone = requireClone(project);
        try (Git git = Git.open(clone.toFile());
                RevWalk walk = new RevWalk(git.getRepository());
                ObjectReader reader = git.getRepository().newObjectReader();
                DiffFormatter formatter = new DiffFormatter(DisabledOutputStream.INSTANCE)) {
            Repository repo = git.getRepository();
            ObjectId objectId;
            try {
                objectId = ObjectId.fromString(sha);
            } catch (IllegalArgumentException e) {
                throw new CommitNotFoundException();
            }
            RevCommit commit = walk.parseCommit(objectId);
            formatter.setRepository(repo);
            formatter.setDetectRenames(true);
            AbstractTreeIterator oldTree = oldTree(walk, reader, commit);
            CanonicalTreeParser newTree = new CanonicalTreeParser();
            newTree.reset(reader, commit.getTree());
            DiffEntry match = formatter.scan(oldTree, newTree).stream()
                    .filter(entry -> normalized.equals(pathOf(entry)))
                    .findFirst()
                    .orElseThrow(CommitNotFoundException::new);
            String oldContent =
                    blobContent(repo, match.getOldId().toObjectId(), match.getChangeType() != DiffEntry.ChangeType.ADD);
            String newContent = blobContent(
                    repo, match.getNewId().toObjectId(), match.getChangeType() != DiffEntry.ChangeType.DELETE);
            return new CommitDiff(match.getChangeType().name(), oldContent, newContent);
        } catch (CommitNotFoundException | FileTooLargeException | InvalidFilePathException e) {
            throw e;
        } catch (IOException | RuntimeException e) {
            throw new CommitNotFoundException();
        }
    }

    @Transactional(readOnly = true)
    public List<RefView> branches(long projectId, long userId) {
        requireOwned(projectId, userId);
        return jdbc.sql("select name, head_sha from branches where project_id = :projectId order by name")
                .param("projectId", projectId)
                .query((rs, rowNum) -> new RefView(rs.getString("name"), rs.getString("head_sha")))
                .list();
    }

    @Transactional(readOnly = true)
    public List<RefView> tags(long projectId, long userId) {
        requireOwned(projectId, userId);
        return jdbc.sql("select name, head_sha from tags where project_id = :projectId order by name")
                .param("projectId", projectId)
                .query((rs, rowNum) -> new RefView(rs.getString("name"), rs.getString("head_sha")))
                .list();
    }

    @Transactional(readOnly = true)
    public List<PullView> pulls(long projectId, long userId, String state) {
        requireOwned(projectId, userId);
        String filter = normalizePullState(state);
        if (filter == null) {
            return jdbc.sql("""
                            select number, title, body, state, author, merged_at, head_sha, base_sha
                            from pull_requests
                            where project_id = :projectId
                            order by number desc
                            """)
                    .param("projectId", projectId)
                    .query(this::mapPull)
                    .list();
        }
        return jdbc.sql("""
                        select number, title, body, state, author, merged_at, head_sha, base_sha
                        from pull_requests
                        where project_id = :projectId and state = :state
                        order by number desc
                        """)
                .param("projectId", projectId)
                .param("state", filter)
                .query(this::mapPull)
                .list();
    }

    private List<CommitSummary> listCommitsOnBranch(Project project, String branch, int page) {
        if (project.getClonePath() == null) {
            return List.of();
        }
        Path cloneRoot = Path.of(project.getClonePath()).toAbsolutePath().normalize();
        Path reposRoot = appProperties.reposRoot();
        if (!cloneRoot.startsWith(reposRoot) || cloneRoot.equals(reposRoot)) {
            throw new InvalidFilePathException();
        }
        List<String> shas;
        try {
            shas = commitShasOnBranch(cloneRoot, branch, page);
        } catch (IOException e) {
            return List.of();
        }
        if (shas.isEmpty()) {
            return List.of();
        }
        Map<String, CommitSummary> bySha = new LinkedHashMap<>();
        jdbc.sql("""
                        select sha, author, message, committed_at, additions, deletions
                        from commits
                        where project_id = :projectId and sha in (:shas)
                        """)
                .param("projectId", project.getId())
                .param("shas", shas)
                .query((rs, rowNum) -> {
                    CommitSummary summary = new CommitSummary(
                            rs.getString("sha"),
                            rs.getString("author"),
                            rs.getString("message"),
                            toInstant(rs.getObject("committed_at", OffsetDateTime.class)),
                            rs.getInt("additions"),
                            rs.getInt("deletions"));
                    bySha.put(summary.sha(), summary);
                    return summary;
                })
                .list();
        return shas.stream().map(bySha::get).filter(Objects::nonNull).toList();
    }

    private static List<String> commitShasOnBranch(Path clone, String branch, int page) throws IOException {
        try (Git git = Git.open(clone.toFile());
                RevWalk walk = new RevWalk(git.getRepository())) {
            ObjectId start = git.getRepository().resolve(branch);
            if (start == null) {
                start = git.getRepository().resolve("refs/heads/" + branch);
            }
            if (start == null) {
                return List.of();
            }
            walk.sort(RevSort.COMMIT_TIME_DESC, true);
            walk.markStart(walk.parseCommit(start));
            int skip = (page - 1) * PAGE_SIZE;
            int seen = 0;
            List<String> shas = new ArrayList<>();
            for (RevCommit commit : walk) {
                if (seen++ < skip) {
                    continue;
                }
                shas.add(commit.getName());
                if (shas.size() >= PAGE_SIZE) {
                    break;
                }
            }
            return shas;
        }
    }

    private String blobContent(org.eclipse.jgit.lib.Repository repo, ObjectId objectId, boolean present)
            throws IOException {
        if (!present || objectId == null || ObjectId.zeroId().equals(objectId)) {
            return null;
        }
        ObjectLoader loader = repo.open(objectId);
        if (loader.getSize() > analysisProperties.maxFileSize()) {
            throw new FileTooLargeException();
        }
        return new String(loader.getBytes(), StandardCharsets.UTF_8);
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

    private static String pathOf(DiffEntry entry) {
        if (entry.getChangeType() == DiffEntry.ChangeType.DELETE) {
            return entry.getOldPath();
        }
        return entry.getNewPath();
    }

    private PullView mapPull(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new PullView(
                rs.getInt("number"),
                rs.getString("title"),
                rs.getString("body"),
                rs.getString("state"),
                rs.getString("author"),
                toInstant(rs.getObject("merged_at", OffsetDateTime.class)),
                rs.getString("head_sha"),
                rs.getString("base_sha"));
    }

    private static String normalizePullState(String state) {
        if (!StringUtils.hasText(state) || "all".equalsIgnoreCase(state)) {
            return null;
        }
        String normalized = state.toLowerCase(Locale.ROOT);
        if ("open".equals(normalized) || "closed".equals(normalized)) {
            return normalized;
        }
        throw new InvalidPullStateException();
    }

    private Project requireOwned(long projectId, long userId) {
        return projectRepository.findByIdAndUserId(projectId, userId).orElseThrow(ProjectNotFoundException::new);
    }

    private Path requireClone(Project project) {
        if (project.getClonePath() == null) {
            throw new CommitNotFoundException();
        }
        Path cloneRoot = Path.of(project.getClonePath()).toAbsolutePath().normalize();
        Path reposRoot = appProperties.reposRoot();
        if (!cloneRoot.startsWith(reposRoot) || cloneRoot.equals(reposRoot)) {
            throw new InvalidFilePathException();
        }
        return cloneRoot;
    }

    private static Instant toInstant(OffsetDateTime value) {
        return value == null ? null : value.toInstant();
    }
}
