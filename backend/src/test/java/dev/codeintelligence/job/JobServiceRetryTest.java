package dev.codeintelligence.job;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

class JobServiceRetryTest {
    @Test
    @SuppressWarnings("unchecked")
    void syntaxInputFailuresRequireANewAnalysisBeforeAnyRetryOrSourceAccess() {
        JobRepository repository = mock(JobRepository.class);
        JobWorker worker = mock(JobWorker.class);
        JobProgressPublisher publisher = mock(JobProgressPublisher.class);
        RetrySourceGuard guard = mock(RetrySourceGuard.class);
        TransactionTemplate tx = mock(TransactionTemplate.class);
        when(tx.execute(any()))
                .thenAnswer(call ->
                        ((TransactionCallback<?>) call.getArgument(0)).doInTransaction(new SimpleTransactionStatus()));
        when(repository.findOwnedJob(1, 7))
                .thenReturn(Optional.of(new JobRecord(
                        1, 2, 9L, JobType.IMPORT, JobStatus.FAILED, "syntax error", null, null, null, "TS_SYNTAX_ERROR")));
        JobService service = new JobService(repository, mock(Pipeline.class), worker, publisher, tx, guard);
        assertThatThrownBy(() -> service.retry(1, 7))
                .isInstanceOfSatisfying(JobConflictException.class, error ->
                        org.assertj.core.api.Assertions.assertThat(error.getBody().getProperties())
                                .containsEntry("code", "TS_SYNTAX_ERROR"));
        verify(repository, never()).markJobQueuedForRetry(1);
        verify(repository, never()).resetStepsForRetry(1);
        verifyNoInteractions(guard, worker, publisher);
    }

    @Test
    @SuppressWarnings("unchecked")
    void losingConcurrentRetryCannotResetTheWinnersRunningSteps() {
        JobRepository repository = mock(JobRepository.class);
        JobWorker worker = mock(JobWorker.class);
        JobProgressPublisher publisher = mock(JobProgressPublisher.class);
        TransactionTemplate tx = mock(TransactionTemplate.class);
        when(tx.execute(any()))
                .thenAnswer(call ->
                        ((TransactionCallback<?>) call.getArgument(0)).doInTransaction(new SimpleTransactionStatus()));
        when(repository.findOwnedJob(1, 7))
                .thenReturn(Optional.of(new JobRecord(
                        1, 2, null, JobType.IMPORT, JobStatus.FAILED, "fixture failure", null, null, null)));
        // Another retry won after the initial ownership/status read.
        when(repository.markJobQueuedForRetry(1)).thenReturn(false);
        JobService service =
                new JobService(repository, mock(Pipeline.class), worker, publisher, tx, mock(RetrySourceGuard.class));
        assertThatThrownBy(() -> service.retry(1, 7)).isInstanceOf(JobConflictException.class);
        verify(repository, never()).resetStepsForRetry(1);
        verifyNoInteractions(worker, publisher);
    }

    @Test
    @SuppressWarnings("unchecked")
    void statusIsReloadedAfterTakingTheProjectLock() {
        JobRepository repository = mock(JobRepository.class);
        JobWorker worker = mock(JobWorker.class);
        JobProgressPublisher publisher = mock(JobProgressPublisher.class);
        RetrySourceGuard guard = mock(RetrySourceGuard.class);
        TransactionTemplate tx = mock(TransactionTemplate.class);
        when(tx.execute(any()))
                .thenAnswer(call ->
                        ((TransactionCallback<?>) call.getArgument(0)).doInTransaction(new SimpleTransactionStatus()));
        when(repository.findOwnedJob(1, 7))
                .thenReturn(
                        Optional.of(
                                new JobRecord(1, 2, null, JobType.IMPORT, JobStatus.FAILED, null, null, null, null)),
                        Optional.of(
                                new JobRecord(1, 2, null, JobType.IMPORT, JobStatus.RUNNING, null, null, null, null)));
        JobService service = new JobService(repository, mock(Pipeline.class), worker, publisher, tx, guard);
        assertThatThrownBy(() -> service.retry(1, 7)).isInstanceOf(JobConflictException.class);
        verify(repository).lockProject(2);
        verify(repository, never()).markJobQueuedForRetry(1);
        verify(repository, never()).resetStepsForRetry(1);
        verifyNoInteractions(guard, worker, publisher);
    }
}
