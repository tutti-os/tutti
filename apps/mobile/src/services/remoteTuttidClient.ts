import { createTuttidClient } from "@tutti-os/client-tuttid-ts";
import { deviceLink } from "../native/mobileNative";

const applicationProtocolEpoch = 1;

const remoteFetch: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  const response = await deviceLink.requestAgentHTTP(
    request.method,
    `${url.pathname}${url.search}`,
    request.method === "GET" || request.method === "HEAD"
      ? ""
      : await request.text(),
    30_000
  );
  if (response.protocolEpoch !== applicationProtocolEpoch) {
    throw new Error("protocol_epoch_mismatch");
  }
  return new Response(response.body, {
    headers: { "Content-Type": "application/json" },
    status: response.status
  });
};

export const remoteTuttidClient = createTuttidClient({
  baseUrl: "http://tuttid.remote",
  fetch: remoteFetch
});
