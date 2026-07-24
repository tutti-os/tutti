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
  const hasBody =
    response.status !== 204 &&
    response.status !== 205 &&
    response.status !== 304;
  const headers = new Headers();
  for (const [name, values] of Object.entries(response.headers)) {
    for (const value of values) {
      headers.append(name, value);
    }
  }
  return new Response(hasBody ? response.body : null, {
    headers,
    status: response.status
  });
};

export const remoteTuttidClient = createTuttidClient({
  baseUrl: "http://tuttid.remote",
  fetch: remoteFetch
});
