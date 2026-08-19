export interface ReferenceReadRequestCoordinator {
  request<T>(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    consumerSignal?: AbortSignal
  ): Promise<T>;
  invalidate(predicate?: (key: string) => boolean): void;
}

interface InFlightRequest {
  abortRequest: () => void;
  consumers: number;
  settled: boolean;
  promise: Promise<unknown>;
}

function abortError(): Error {
  const error = new Error("reference read request aborted");
  error.name = "AbortError";
  return error;
}

/**
 * 只协调正在执行的幂等读取，不保存成功结果或错误。
 *
 * 每个消费者拥有独立取消语义；只有最后一个消费者退出时才取消底层请求。
 */
export function createReferenceReadRequestCoordinator(): ReferenceReadRequestCoordinator {
  const requests = new Map<string, InFlightRequest>();

  return {
    request<T>(
      key: string,
      load: (signal: AbortSignal) => Promise<T>,
      consumerSignal?: AbortSignal
    ): Promise<T> {
      if (consumerSignal?.aborted) {
        return Promise.reject(abortError());
      }

      let entry = requests.get(key);
      if (!entry) {
        const controller = new AbortController();
        let rejectAbort!: (error: Error) => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          rejectAbort = reject;
        });
        entry = {
          abortRequest: () => {
            controller.abort();
            rejectAbort(abortError());
          },
          consumers: 0,
          settled: false,
          promise: Promise.resolve()
        };
        const current = entry;
        current.promise = Promise.race([
          Promise.resolve().then(() => load(controller.signal)),
          aborted
        ]).finally(() => {
          current.settled = true;
          if (requests.get(key) === current) {
            requests.delete(key);
          }
        });
        requests.set(key, current);
      }

      const current = entry;
      current.consumers += 1;

      return new Promise<T>((resolve, reject) => {
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          consumerSignal?.removeEventListener("abort", onAbort);
          current.consumers -= 1;
          if (current.consumers === 0 && !current.settled) {
            if (requests.get(key) === current) {
              requests.delete(key);
            }
            current.abortRequest();
          }
        };
        const onAbort = (): void => {
          release();
          reject(abortError());
        };

        consumerSignal?.addEventListener("abort", onAbort, { once: true });
        current.promise.then(
          (value) => {
            if (released) return;
            release();
            resolve(value as T);
          },
          (error: unknown) => {
            if (released) return;
            release();
            reject(error);
          }
        );
      });
    },

    invalidate(predicate = () => true): void {
      for (const [key, request] of requests) {
        if (!predicate(key)) continue;
        requests.delete(key);
        request.abortRequest();
      }
    }
  };
}
