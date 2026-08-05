#import "DeviceLinkRelayProbe.h"

static NSError *TUTRelayProbeError(NSString *message) {
  return [NSError errorWithDomain:@"dev.tutti.mobile.device-link.relay-probe"
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

void TUTDeviceLinkProbeRelay(
    NSDictionary *relay, int64_t timeoutMillis, dispatch_queue_t queue,
    TUTDeviceLinkRelayRequest request,
    TUTDeviceLinkRelayProbeCompletion completion) {
  dispatch_async(queue, ^{
    NSError *error = nil;
    TUTMobileStream *stream = TUTMobileDialRelay(
        relay[@"endpoint"], relay[@"queryJSON"], relay[@"headersJSON"],
        relay[@"subprotocol"], timeoutMillis, &error);
    NSDictionary *response = nil;
    if (stream != nil && error == nil) {
      response = request(stream, timeoutMillis, &error);
    }
    if (response == nil || error != nil) {
      completion(error ?: TUTRelayProbeError(@"Relay peer handshake failed"));
      return;
    }
    NSNumber *protocolEpoch = response[@"protocolEpoch"];
    if (![protocolEpoch isKindOfClass:[NSNumber class]] ||
        protocolEpoch.longLongValue != TUTMobileProtocolEpoch()) {
      completion(TUTRelayProbeError(
          @"Relay peer uses an unsupported DeviceLink protocol epoch"));
      return;
    }
    NSInteger status = [response[@"status"] integerValue];
    if (status < 200 || status > 299) {
      completion(TUTRelayProbeError([NSString stringWithFormat:
                                                  @"Relay peer control request returned HTTP %ld",
                                                  (long)status]));
      return;
    }
    completion(nil);
  });
}
