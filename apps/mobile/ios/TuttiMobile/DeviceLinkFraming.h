#import <Foundation/Foundation.h>
#import <TuttiMobileGo/TUTMobile.objc.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT BOOL TUTDeviceLinkWriteFully(TUTMobileStream *stream,
                                               NSData *payload,
                                               NSError **error);
FOUNDATION_EXPORT NSData *_Nullable
TUTDeviceLinkReadFully(TUTMobileStream *stream, NSUInteger size,
                       NSError **error);
FOUNDATION_EXPORT NSData *TUTDeviceLinkFrame(NSData *payload);
FOUNDATION_EXPORT NSUInteger TUTDeviceLinkReadFrameSize(
    TUTMobileStream *stream, NSUInteger maximum, NSError **error);

NS_ASSUME_NONNULL_END
