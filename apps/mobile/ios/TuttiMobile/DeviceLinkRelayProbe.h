#import <Foundation/Foundation.h>
#import <TuttiMobileGo/TUTMobile.objc.h>

NS_ASSUME_NONNULL_BEGIN

typedef NSDictionary *_Nullable (^TUTDeviceLinkRelayRequest)(
    TUTMobileStream *stream, int64_t timeoutMillis, NSError **error);
typedef void (^TUTDeviceLinkRelayProbeCompletion)(NSError *_Nullable error);

FOUNDATION_EXPORT void TUTDeviceLinkProbeRelay(
    NSDictionary *relay, int64_t timeoutMillis, dispatch_queue_t queue,
    TUTDeviceLinkRelayRequest request,
    TUTDeviceLinkRelayProbeCompletion completion);

NS_ASSUME_NONNULL_END
