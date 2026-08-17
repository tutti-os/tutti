package sh.tutti.mobile

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceLinkOperationExecutorTest {
    @Test
    fun `candidate action resolution runs while three operations are blocked`() {
        val executor = newDeviceLinkOperationExecutor()
        val blockersStarted = CountDownLatch(3)
        val releaseBlockers = CountDownLatch(1)
        try {
            repeat(3) {
                executor.execute {
                    blockersStarted.countDown()
                    runCatching { releaseBlockers.await() }
                }
            }
            assertTrue(blockersStarted.await(1, TimeUnit.SECONDS))

            val candidateActionResolved = CountDownLatch(1)
            executor.execute(candidateActionResolved::countDown)

            assertTrue(
                "candidate action resolution was queued behind blocking operations",
                candidateActionResolved.await(1, TimeUnit.SECONDS),
            )
        } finally {
            releaseBlockers.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun `candidate resolution is isolated from queued application operations`() {
        val operations = newDeviceLinkOperationExecutor()
        val candidates = newDeviceLinkCandidateExecutor()
        val operationBlockersStarted = CountDownLatch(DEVICE_LINK_OPERATION_WORKERS)
        val releaseOperations = CountDownLatch(1)
        val candidateBlockersStarted = CountDownLatch(DEVICE_LINK_CANDIDATE_WORKERS)
        val releaseOneCandidate = CountDownLatch(1)
        val releaseAllCandidates = CountDownLatch(1)
        try {
            repeat(DEVICE_LINK_OPERATION_WORKERS) {
                operations.execute {
                    operationBlockersStarted.countDown()
                    runCatching { releaseOperations.await() }
                }
            }
            assertTrue(operationBlockersStarted.await(1, TimeUnit.SECONDS))
            // Queue ordinary Agent I/O behind every occupied operation worker.
            repeat(8) { operations.execute {} }

            candidates.execute {
                candidateBlockersStarted.countDown()
                runCatching { releaseOneCandidate.await() }
            }
            candidates.execute {
                candidateBlockersStarted.countDown()
                runCatching { releaseAllCandidates.await() }
            }
            assertTrue(candidateBlockersStarted.await(1, TimeUnit.SECONDS))

            releaseOneCandidate.countDown()
            val candidateActionResolved = CountDownLatch(1)
            candidates.execute(candidateActionResolved::countDown)

            assertTrue(
                "candidate resolution was starved by application I/O",
                candidateActionResolved.await(1, TimeUnit.SECONDS),
            )
        } finally {
            releaseOneCandidate.countDown()
            releaseAllCandidates.countDown()
            releaseOperations.countDown()
            candidates.shutdownNow()
            operations.shutdownNow()
        }
    }
}
