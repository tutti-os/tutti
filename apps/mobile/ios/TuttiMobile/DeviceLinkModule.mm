#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTLog.h>
#import <TuttiMobileGo/TUTLiveprotocolmobile.objc.h>
#import <TuttiMobileGo/TUTMobile.objc.h>
#import <UIKit/UIKit.h>

static NSString *const TUTAgentLiveEventName = @"TuttiDeviceLinkAgentLive";
static const int64_t TUTAgentLiveOpenTimeoutMillis = 10000;
static const NSTimeInterval TUTBackgroundGraceSeconds = 15.0;
static const NSUInteger TUTMaxAgentLiveFrameBytes = 2 << 20;
static const NSUInteger TUTMaxReadChunk = 1 << 20;
static const NSUInteger TUTMaxRequestBodyBytes = 8 << 20;
static const NSUInteger TUTMaxResponseBodyBytes = 16 << 20;
static const NSUInteger TUTFrameEnvelopeBytes = 1 << 20;
static const NSUInteger TUTMaxRequestFrameBytes =
    ((TUTMaxRequestBodyBytes + 2) / 3 * 4) + TUTFrameEnvelopeBytes;
static const NSUInteger TUTMaxResponseFrameBytes =
    ((TUTMaxResponseBodyBytes + 2) / 3 * 4) + TUTFrameEnvelopeBytes;

static NSError *TUTDeviceLinkError(NSString *code, NSString *message) {
  return [NSError errorWithDomain:@"dev.tutti.mobile.device-link"
                             code:1
                         userInfo:@{
                           NSLocalizedDescriptionKey : message,
                           @"code" : code,
                         }];
}

static NSData *TUTJSONData(id value, NSError **error) {
  return [NSJSONSerialization dataWithJSONObject:value options:0 error:error];
}

static NSDictionary *TUTJSONObject(NSData *data, NSError **error) {
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
  if (![value isKindOfClass:[NSDictionary class]]) {
    if (error != NULL && *error == nil) {
      *error = TUTDeviceLinkError(@"INVALID_RESPONSE",
                                  @"DeviceLink response is not an object");
    }
    return nil;
  }
  return value;
}

static BOOL TUTWriteFully(TUTMobileStream *stream, NSData *payload,
                          NSError **error) {
  NSUInteger offset = 0;
  while (offset < payload.length) {
    NSData *chunk = offset == 0
                        ? payload
                        : [payload subdataWithRange:NSMakeRange(
                              offset, payload.length - offset)];
    long written = 0;
    if (![stream write:chunk ret0_:&written error:error]) {
      return NO;
    }
    if (written <= 0 || (NSUInteger)written > chunk.length) {
      if (error != NULL) {
        *error = TUTDeviceLinkError(
            @"INVALID_WRITE",
            @"DeviceLink stream returned an invalid write count");
      }
      return NO;
    }
    offset += (NSUInteger)written;
  }
  return YES;
}

static NSData *TUTReadFully(TUTMobileStream *stream, NSUInteger size,
                            NSError **error) {
  NSMutableData *output = [NSMutableData dataWithCapacity:size];
  while (output.length < size) {
    NSUInteger remaining = size - output.length;
    NSMutableData *chunk =
        [NSMutableData dataWithLength:MIN(remaining, TUTMaxReadChunk)];
    long count = [stream readInto:chunk];
    if (count <= 0 || (NSUInteger)count > chunk.length) {
      if (error != NULL) {
        *error = TUTDeviceLinkError(
            @"INCOMPLETE_FRAME",
            @"DeviceLink stream closed before the response completed");
      }
      return nil;
    }
    [output appendBytes:chunk.bytes length:(NSUInteger)count];
  }
  return output;
}

static NSData *TUTFrame(NSData *payload) {
  uint32_t size = CFSwapInt32HostToBig((uint32_t)payload.length);
  NSMutableData *framed =
      [NSMutableData dataWithBytes:&size length:sizeof(size)];
  [framed appendData:payload];
  return framed;
}

static NSUInteger TUTReadFrameSize(TUTMobileStream *stream, NSUInteger maximum,
                                   NSError **error) {
  NSData *header = TUTReadFully(stream, sizeof(uint32_t), error);
  if (header == nil) {
    return 0;
  }
  uint32_t encoded = 0;
  [header getBytes:&encoded length:sizeof(encoded)];
  NSUInteger size = (NSUInteger)CFSwapInt32BigToHost(encoded);
  if (size == 0 || size > maximum) {
    if (error != NULL) {
      *error = TUTDeviceLinkError(@"INVALID_FRAME",
                                  @"DeviceLink frame size is invalid");
    }
    return 0;
  }
  return size;
}

@interface TuttiDeviceLink : RCTEventEmitter <RCTBridgeModule>
@property(nonatomic, strong) TUTMobileLink *link;
@property(nonatomic, strong) TUTMobileStream *agentLiveStream;
@property(nonatomic, copy) NSString *relayEndpoint;
@property(nonatomic, copy) NSString *relayQueryJSON;
@property(nonatomic, copy) NSString *relayHeadersJSON;
@property(nonatomic, copy) NSString *relaySubprotocol;
@property(nonatomic, assign) int64_t linkGeneration;
@property(nonatomic, assign) int64_t agentLiveGeneration;
@property(nonatomic, strong) dispatch_queue_t operationQueue;
@property(nonatomic, strong) dispatch_queue_t closeQueue;
@property(nonatomic, strong) dispatch_queue_t agentLiveQueue;
@property(nonatomic, strong) dispatch_block_t backgroundClose;
@property(nonatomic, assign) BOOL observing;
@end

@implementation TuttiDeviceLink

RCT_EXPORT_MODULE(TuttiDeviceLink)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _operationQueue = dispatch_queue_create(
        "dev.tutti.mobile.device-link.operations", DISPATCH_QUEUE_CONCURRENT);
    _closeQueue = dispatch_queue_create("dev.tutti.mobile.device-link.close",
                                        DISPATCH_QUEUE_SERIAL);
    _agentLiveQueue = dispatch_queue_create(
        "dev.tutti.mobile.device-link.agent-live", DISPATCH_QUEUE_SERIAL);
    [[NSNotificationCenter defaultCenter]
        addObserver:self
           selector:@selector(applicationDidEnterBackground)
               name:UIApplicationDidEnterBackgroundNotification
             object:nil];
    [[NSNotificationCenter defaultCenter]
        addObserver:self
           selector:@selector(applicationWillEnterForeground)
               name:UIApplicationWillEnterForegroundNotification
             object:nil];
  }
  return self;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ TUTAgentLiveEventName ];
}

- (void)startObserving {
  @synchronized(self) {
    self.observing = YES;
  }
}

- (void)stopObserving {
  @synchronized(self) {
    self.observing = NO;
  }
}

RCT_REMAP_METHOD(probeEpoch,
                 probeEpochWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@(TUTMobileProbeEpoch()));
}

RCT_REMAP_METHOD(protocolEpoch,
                 protocolEpochWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@(TUTMobileProtocolEpoch()));
}

RCT_REMAP_METHOD(runLoopbackProbe,
                 runLoopbackProbe:(double)timeoutMillis
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(self.operationQueue, ^{
    NSError *error = nil;
    NSString *result =
        TUTMobileRunLoopbackProbe((int64_t)timeoutMillis, &error);
    if (error != nil) {
      reject(@"DEVICE_LINK_PROBE_FAILED", @"DeviceLink probe failed", error);
      return;
    }
    resolve(result);
  });
}

RCT_REMAP_METHOD(prepareLink,
                 prepareLink:(NSString *)stunEndpointsJSON
                 timeoutMillis:(double)timeoutMillis
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  int64_t generation = [self beginLinkOperation];
  dispatch_async(self.operationQueue, ^{
    NSError *error = nil;
    TUTMobileLink *prepared = TUTMobileNewLink(stunEndpointsJSON, &error);
    if (prepared == nil || error != nil) {
      reject(@"DEVICE_LINK_PREPARE_FAILED", @"Unable to prepare DeviceLink",
             error);
      return;
    }
    NSString *description =
        [prepared localDescription:(int64_t)timeoutMillis error:&error];
    if (description == nil || error != nil) {
      [self closeDetachedLink:prepared];
      reject(@"DEVICE_LINK_PREPARE_FAILED", @"Unable to prepare DeviceLink",
             error);
      return;
    }
    if (![self promoteLink:prepared generation:generation]) {
      [self closeDetachedLink:prepared];
      reject(@"DEVICE_LINK_PREPARE_FAILED",
             @"DeviceLink prepare was cancelled",
             TUTDeviceLinkError(@"CANCELLED",
                                @"DeviceLink prepare was cancelled"));
      return;
    }
    resolve(@{
      @"descriptionJSON" : description,
      @"token" : @(generation),
    });
  });
}

RCT_REMAP_METHOD(connectLink,
                 connectLink:(NSString *)peerDescriptionJSON
                 caller:(BOOL)caller
                 token:(double)token
                 timeoutMillis:(double)timeoutMillis
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  TUTMobileLink *selected = [self linkSnapshotForGeneration:(int64_t)token];
  if (selected == nil) {
    reject(@"DEVICE_LINK_CONNECT_FAILED",
           @"DeviceLink preparation is no longer current", nil);
    return;
  }
  dispatch_async(self.operationQueue, ^{
    NSError *error = nil;
    NSString *scope = [selected connect:peerDescriptionJSON
                                 caller:caller
                          timeoutMillis:(int64_t)timeoutMillis
                                  error:&error];
    if (error != nil) {
      reject(@"DEVICE_LINK_CONNECT_FAILED", @"Unable to connect DeviceLink",
             error);
      return;
    }
    resolve(scope);
  });
}

RCT_REMAP_METHOD(configureRelay,
                 configureRelay:(NSString *)endpoint
                 queryJSON:(NSString *)queryJSON
                 headersJSON:(NSString *)headersJSON
                 subprotocol:(NSString *)subprotocol
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *normalizedEndpoint =
      [endpoint stringByTrimmingCharactersInSet:
                    [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  NSString *normalizedSubprotocol =
      [subprotocol stringByTrimmingCharactersInSet:
                      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (normalizedEndpoint.length == 0 || normalizedSubprotocol.length == 0) {
    reject(@"DEVICE_LINK_RELAY_CONFIG_FAILED",
           @"Relay endpoint and subprotocol are required", nil);
    return;
  }
  @synchronized(self) {
    self.relayEndpoint = normalizedEndpoint;
    self.relayQueryJSON = queryJSON ?: @"";
    self.relayHeadersJSON = headersJSON ?: @"";
    self.relaySubprotocol = normalizedSubprotocol;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(requestAgentHTTP,
                 requestAgentHTTP:(NSString *)method
                 path:(NSString *)path
                 body:(NSString *)body
                 timeoutMillis:(double)timeoutMillis
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  TUTMobileLink *selected = [self linkSnapshot];
  NSDictionary *relay = [self relaySnapshot];
  if (selected == nil && relay == nil) {
    reject(@"DEVICE_LINK_REQUEST_FAILED", @"DeviceLink is not prepared", nil);
    return;
  }
  dispatch_async(self.operationQueue, ^{
    NSError *error = nil;
    NSDictionary *response = nil;
    if (selected != nil) {
      response = [self requestAgentHTTPWithLink:selected
                                         method:method
                                           path:path
                                           body:body
                                  timeoutMillis:(int64_t)timeoutMillis
                                          error:&error];
    }
    if (response == nil && relay != nil) {
      NSError *relayError = nil;
      TUTMobileStream *stream = TUTMobileDialRelay(
          relay[@"endpoint"], relay[@"queryJSON"], relay[@"headersJSON"],
          relay[@"subprotocol"], (int64_t)timeoutMillis, &relayError);
      if (stream != nil && relayError == nil) {
        response = [self requestAgentHTTPWithStream:stream
                                              method:method
                                                path:path
                                                body:body
                                         timeoutMillis:(int64_t)timeoutMillis
                                                 error:&relayError];
      }
      if (response != nil) {
        error = nil;
      } else if (error == nil) {
        error = relayError;
      }
    }
    if (response == nil || error != nil) {
      reject(@"DEVICE_LINK_REQUEST_FAILED", @"DeviceLink request failed",
             error);
      return;
    }
    resolve(response);
  });
}

RCT_REMAP_METHOD(startAgentLive,
                 startAgentLive:(NSString *)workspaceID
                 subscriptionGeneration:(nonnull NSNumber *)subscriptionGeneration
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *normalized =
      [workspaceID stringByTrimmingCharactersInSet:
                       [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (normalized.length == 0) {
    reject(@"AGENT_LIVE_SUBSCRIBE_FAILED",
           @"Agent live workspace id is required", nil);
    return;
  }
  if (subscriptionGeneration.longLongValue <= 0 ||
      subscriptionGeneration.doubleValue !=
          (double)subscriptionGeneration.longLongValue) {
    reject(@"AGENT_LIVE_SUBSCRIBE_FAILED",
           @"Agent live subscription generation must be a positive integer",
           nil);
    return;
  }
  TUTMobileLink *selected = [self linkSnapshot];
  NSDictionary *relay = [self relaySnapshot];
  if (selected == nil && relay == nil) {
    reject(@"AGENT_LIVE_SUBSCRIBE_FAILED", @"DeviceLink is not prepared", nil);
    return;
  }
  int64_t generation = [self beginAgentLiveOperation];
  dispatch_async(self.agentLiveQueue, ^{
    NSError *error = nil;
    TUTMobileStream *stream = [self openAgentStream:selected
                                              relay:relay
                                      timeoutMillis:TUTAgentLiveOpenTimeoutMillis
                                              error:&error];
    if (stream == nil || error != nil) {
      reject(@"AGENT_LIVE_SUBSCRIBE_FAILED",
             @"Unable to start Agent live subscription", error);
      return;
    }
    if (![self promoteAgentLiveStream:stream generation:generation]) {
      [self closeDetachedStream:stream];
      reject(@"AGENT_LIVE_SUBSCRIBE_FAILED",
             @"Agent live subscription was cancelled", nil);
      return;
    }

    TUTLiveprotocolmobileSubscriber *subscriber =
        TUTLiveprotocolmobileNewSubscriber(0, 0, &error);
    if (subscriber == nil || error != nil) {
      [self clearAgentLiveStream:stream generation:generation];
      [self closeDetachedStream:stream];
      reject(@"AGENT_LIVE_SUBSCRIBE_FAILED",
             @"Unable to create Agent live subscriber", error);
      return;
    }
    NSDictionary *subscription = @{
      @"protocolRevision" : TUTLiveprotocolmobileProtocolRevision(),
      @"workspaceId" : normalized,
    };
    NSData *subscriptionData = TUTJSONData(subscription, &error);
    if (subscriptionData == nil || error != nil) {
      [self clearAgentLiveStream:stream generation:generation];
      [self closeDetachedStream:stream];
      reject(@"AGENT_LIVE_SUBSCRIBE_FAILED",
             @"Unable to encode Agent live subscription", error);
      return;
    }
    NSString *requestID = [NSUUID UUID].UUIDString;
    NSDictionary *request = @{
      @"protocolEpoch" : @(TUTMobileProtocolEpoch()),
      @"service" : @"agent_live",
      @"requestId" : requestID,
      @"method" : @"SUBSCRIBE",
      @"path" : [NSString
          stringWithFormat:@"/v1/workspaces/%@/agent-live", normalized],
      @"body" : [subscriptionData base64EncodedStringWithOptions:0],
    };
    NSData *requestData = TUTJSONData(request, &error);
    if (requestData == nil || requestData.length > TUTMaxRequestFrameBytes ||
        !TUTWriteFully(stream, TUTFrame(requestData), &error)) {
      [self clearAgentLiveStream:stream generation:generation];
      [self closeDetachedStream:stream];
      reject(@"AGENT_LIVE_SUBSCRIBE_FAILED",
             @"Unable to start Agent live subscription", error);
      return;
    }

    resolve(nil);
    while ([self isAgentLiveCurrent:stream generation:generation]) {
      NSUInteger size =
          TUTReadFrameSize(stream, TUTMaxAgentLiveFrameBytes, &error);
      if (size == 0) {
        break;
      }
      NSData *frame = TUTReadFully(stream, size, &error);
      NSString *result =
          frame == nil ? nil
                       : [subscriber apply:frame error:&error];
      if (result == nil || error != nil) {
        break;
      }
      if ([self isAgentLiveCurrent:stream generation:generation]) {
        NSDictionary *delivery = @{
          @"workspaceId" : normalized,
          @"subscriptionGeneration" : subscriptionGeneration,
          @"result" : [self objectFromJSONString:result] ?: @{},
        };
        NSData *encoded = TUTJSONData(delivery, nil);
        NSString *payload =
            [[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding];
        [self emitAgentLive:payload];
      }
    }

    BOOL current =
        [self isAgentLiveGenerationCurrent:generation];
    [self clearAgentLiveStream:stream generation:generation];
    [self closeDetachedStream:stream];
    if (current) {
      NSData *encoded = TUTJSONData(@{
        @"workspaceId" : normalized,
        @"subscriptionGeneration" : subscriptionGeneration,
        @"status" : @"disconnected",
        @"reason" : @"stream_closed",
      }, nil);
      [self emitAgentLive:[[NSString alloc] initWithData:encoded
                                                encoding:NSUTF8StringEncoding]];
    }
  });
}

RCT_REMAP_METHOD(stopAgentLive,
                 stopAgentLiveWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self closeCurrentAgentLiveStream];
  resolve(nil);
}

RCT_REMAP_METHOD(closeLink,
                 closeLinkWithResolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject) {
  [self closeCurrentLink];
  resolve(nil);
}

- (NSDictionary *)requestAgentHTTPWithLink:(TUTMobileLink *)link
                                    method:(NSString *)method
                                      path:(NSString *)path
                                     body:(NSString *)body
                            timeoutMillis:(int64_t)timeoutMillis
                                     error:(NSError **)error {
  int64_t timeout = MAX(timeoutMillis, 1);
  TUTMobileStream *stream = [link openStream:timeout error:error];
  if (stream == nil) {
    return nil;
  }
  return [self requestAgentHTTPWithStream:stream
                                   method:method
                                     path:path
                                     body:body
                            timeoutMillis:timeoutMillis
                                    error:error];
}

- (NSDictionary *)requestAgentHTTPWithStream:(TUTMobileStream *)stream
                                      method:(NSString *)method
                                        path:(NSString *)path
                                        body:(NSString *)body
                               timeoutMillis:(int64_t)timeoutMillis
                                       error:(NSError **)error {
  int64_t timeout = MAX(timeoutMillis, 1);
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout / 1000.0];
  @try {
    int64_t remaining =
        MAX((int64_t)([deadline timeIntervalSinceNow] * 1000.0), 1);
    if (![stream setDeadline:remaining error:error]) {
      return nil;
    }
    NSData *bodyData = [body dataUsingEncoding:NSUTF8StringEncoding];
    if (bodyData.length > TUTMaxRequestBodyBytes) {
      if (error != NULL) {
        *error = TUTDeviceLinkError(
            @"REQUEST_TOO_LARGE",
            @"DeviceLink request body exceeds the supported limit");
      }
      return nil;
    }
    NSString *requestID = [NSUUID UUID].UUIDString;
    NSDictionary *request = @{
      @"protocolEpoch" : @(TUTMobileProtocolEpoch()),
      @"service" : @"agent_http",
      @"requestId" : requestID,
      @"method" : method,
      @"path" : path,
      @"headers" : @{
        @"Accept" : @[ @"application/json" ],
        @"Content-Type" : @[ @"application/json" ],
      },
      @"body" : [bodyData base64EncodedStringWithOptions:0],
    };
    NSData *payload = TUTJSONData(request, error);
    if (payload == nil || payload.length > TUTMaxRequestFrameBytes) {
      return nil;
    }
    if (!TUTWriteFully(stream, TUTFrame(payload), error)) {
      return nil;
    }
    NSUInteger responseSize =
        TUTReadFrameSize(stream, TUTMaxResponseFrameBytes, error);
    if (responseSize == 0) {
      return nil;
    }
    NSData *responseData = TUTReadFully(stream, responseSize, error);
    if (responseData == nil) {
      return nil;
    }
    NSDictionary *response = TUTJSONObject(responseData, error);
    if (response == nil ||
        ![response[@"requestId"] isEqualToString:requestID]) {
      if (error != NULL && *error == nil) {
        *error = TUTDeviceLinkError(
            @"INVALID_RESPONSE",
            @"DeviceLink response request id does not match");
      }
      return nil;
    }
    NSString *encodedBody =
        [response[@"body"] isKindOfClass:[NSString class]]
            ? response[@"body"]
            : @"";
    NSData *decoded =
        [[NSData alloc] initWithBase64EncodedString:encodedBody options:0];
    NSString *responseBody =
        decoded == nil
            ? @""
            : [[NSString alloc] initWithData:decoded
                                    encoding:NSUTF8StringEncoding] ?: @"";
    return @{
      @"protocolEpoch" : response[@"protocolEpoch"] ?: @0,
      @"status" : response[@"status"] ?: @0,
      @"body" : responseBody,
      @"errorCode" : response[@"errorCode"] ?: @"",
      @"headers" : [response[@"headers"] isKindOfClass:[NSDictionary class]]
                       ? response[@"headers"]
                       : @{},
    };
  } @finally {
    [stream close:nil];
  }
}

- (NSDictionary *)relaySnapshot {
  @synchronized(self) {
    if (self.relayEndpoint.length == 0 ||
        self.relaySubprotocol.length == 0) {
      return nil;
    }
    return @{
      @"endpoint" : self.relayEndpoint,
      @"queryJSON" : self.relayQueryJSON ?: @"",
      @"headersJSON" : self.relayHeadersJSON ?: @"",
      @"subprotocol" : self.relaySubprotocol,
    };
  }
}

- (TUTMobileStream *)openAgentStream:(TUTMobileLink *)link
                               relay:(NSDictionary *)relay
                       timeoutMillis:(int64_t)timeoutMillis
                               error:(NSError **)error {
  NSError *directError = nil;
  if (link != nil) {
    TUTMobileStream *stream = [link openStream:MAX(timeoutMillis, 1)
                                         error:&directError];
    if (stream != nil) {
      return stream;
    }
  }
  if (relay != nil) {
    NSError *relayError = nil;
    TUTMobileStream *stream = TUTMobileDialRelay(
        relay[@"endpoint"], relay[@"queryJSON"], relay[@"headersJSON"],
        relay[@"subprotocol"], MAX(timeoutMillis, 1), &relayError);
    if (stream != nil) {
      return stream;
    }
    if (error != NULL) {
      *error = relayError ?: directError;
    }
    return nil;
  }
  if (error != NULL) {
    *error = directError;
  }
  return nil;
}

- (NSDictionary *)objectFromJSONString:(NSString *)json {
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  return data == nil ? nil : TUTJSONObject(data, nil);
}

- (int64_t)beginLinkOperation {
  @synchronized(self) {
    self.linkGeneration += 1;
    return self.linkGeneration;
  }
}

- (BOOL)promoteLink:(TUTMobileLink *)next generation:(int64_t)generation {
  TUTMobileLink *previous = nil;
  @synchronized(self) {
    if (generation != self.linkGeneration) {
      return NO;
    }
    previous = self.link;
    self.link = next;
  }
  if (previous != nil && previous != next) {
    [self closeDetachedLink:previous];
  }
  return YES;
}

- (TUTMobileLink *)linkSnapshot {
  @synchronized(self) {
    return self.link;
  }
}

- (TUTMobileLink *)linkSnapshotForGeneration:(int64_t)generation {
  @synchronized(self) {
    return generation == self.linkGeneration ? self.link : nil;
  }
}

- (void)closeCurrentLink {
  [self closeCurrentAgentLiveStream];
  TUTMobileLink *previous = nil;
  @synchronized(self) {
    self.linkGeneration += 1;
    previous = self.link;
    self.link = nil;
    self.relayEndpoint = nil;
    self.relayQueryJSON = nil;
    self.relayHeadersJSON = nil;
    self.relaySubprotocol = nil;
  }
  [self closeDetachedLink:previous];
}

- (void)closeDetachedLink:(TUTMobileLink *)link {
  if (link == nil) {
    return;
  }
  dispatch_async(self.closeQueue, ^{
    [link close:nil];
  });
}

- (int64_t)beginAgentLiveOperation {
  TUTMobileStream *previous = nil;
  int64_t generation = 0;
  @synchronized(self) {
    self.agentLiveGeneration += 1;
    generation = self.agentLiveGeneration;
    previous = self.agentLiveStream;
    self.agentLiveStream = nil;
  }
  [self closeDetachedStream:previous];
  return generation;
}

- (BOOL)promoteAgentLiveStream:(TUTMobileStream *)stream
                    generation:(int64_t)generation {
  @synchronized(self) {
    if (generation != self.agentLiveGeneration) {
      return NO;
    }
    self.agentLiveStream = stream;
    return YES;
  }
}

- (BOOL)isAgentLiveCurrent:(TUTMobileStream *)stream
                generation:(int64_t)generation {
  @synchronized(self) {
    return generation == self.agentLiveGeneration &&
           self.agentLiveStream == stream;
  }
}

- (BOOL)isAgentLiveGenerationCurrent:(int64_t)generation {
  @synchronized(self) {
    return generation == self.agentLiveGeneration;
  }
}

- (void)clearAgentLiveStream:(TUTMobileStream *)stream
                  generation:(int64_t)generation {
  @synchronized(self) {
    if (generation == self.agentLiveGeneration &&
        self.agentLiveStream == stream) {
      self.agentLiveStream = nil;
    }
  }
}

- (void)closeCurrentAgentLiveStream {
  TUTMobileStream *previous = nil;
  @synchronized(self) {
    self.agentLiveGeneration += 1;
    previous = self.agentLiveStream;
    self.agentLiveStream = nil;
  }
  [self closeDetachedStream:previous];
}

- (void)closeDetachedStream:(TUTMobileStream *)stream {
  if (stream == nil) {
    return;
  }
  dispatch_async(self.closeQueue, ^{
    [stream close:nil];
  });
}

- (void)emitAgentLive:(NSString *)payload {
  if (payload.length == 0) {
    return;
  }
  @synchronized(self) {
    if (!self.observing) {
      return;
    }
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [self sendEventWithName:TUTAgentLiveEventName body:payload];
  });
}

- (void)applicationDidEnterBackground {
  [self closeCurrentAgentLiveStream];
  @synchronized(self) {
    if (self.backgroundClose != nil) {
      dispatch_block_cancel(self.backgroundClose);
    }
    __weak TuttiDeviceLink *weakSelf = self;
    self.backgroundClose =
        dispatch_block_create(DISPATCH_BLOCK_INHERIT_QOS_CLASS, ^{
      [weakSelf closeCurrentLink];
    });
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW,
                      (int64_t)(TUTBackgroundGraceSeconds * NSEC_PER_SEC)),
        dispatch_get_main_queue(), self.backgroundClose);
  }
}

- (void)applicationWillEnterForeground {
  @synchronized(self) {
    if (self.backgroundClose != nil) {
      dispatch_block_cancel(self.backgroundClose);
      self.backgroundClose = nil;
    }
  }
}

- (void)invalidate {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  [self applicationWillEnterForeground];
  [self closeCurrentLink];
  [super invalidate];
}

@end
