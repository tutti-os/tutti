package sh.tutti.mobile

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal const val DEVICE_LINK_OPERATION_WORKERS = 4
internal const val DEVICE_LINK_CANDIDATE_WORKERS = 2

internal fun newDeviceLinkOperationExecutor(): ThreadPoolExecutor =
    ThreadPoolExecutor(
        DEVICE_LINK_OPERATION_WORKERS,
        DEVICE_LINK_OPERATION_WORKERS,
        30,
        TimeUnit.SECONDS,
        ArrayBlockingQueue(16),
        ThreadPoolExecutor.AbortPolicy(),
    )

internal fun newDeviceLinkCandidateExecutor(): ThreadPoolExecutor =
    ThreadPoolExecutor(
        DEVICE_LINK_CANDIDATE_WORKERS,
        DEVICE_LINK_CANDIDATE_WORKERS,
        30,
        TimeUnit.SECONDS,
        ArrayBlockingQueue(8),
        ThreadPoolExecutor.AbortPolicy(),
    )
