#import "DeviceLinkFraming.h"

static const NSUInteger TUTDeviceLinkFramingMaxReadChunk = 1 << 20;

static NSError *TUTDeviceLinkFramingError(NSString *code, NSString *message) {
  return [NSError errorWithDomain:@"dev.tutti.mobile.device-link"
                             code:1
                         userInfo:@{
                           NSLocalizedDescriptionKey : message,
                           @"code" : code,
                         }];
}

BOOL TUTDeviceLinkWriteFully(TUTMobileStream *stream, NSData *payload,
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
        *error = TUTDeviceLinkFramingError(
            @"INVALID_WRITE",
            @"DeviceLink stream returned an invalid write count");
      }
      return NO;
    }
    offset += (NSUInteger)written;
  }
  return YES;
}

NSData *TUTDeviceLinkReadFully(TUTMobileStream *stream, NSUInteger size,
                               NSError **error) {
  NSMutableData *output = [NSMutableData dataWithCapacity:size];
  while (output.length < size) {
    NSUInteger remaining = size - output.length;
    NSMutableData *chunk = [NSMutableData
        dataWithLength:MIN(remaining, TUTDeviceLinkFramingMaxReadChunk)];
    long count = [stream readInto:chunk];
    if (count <= 0 || (NSUInteger)count > chunk.length) {
      if (error != NULL) {
        *error = TUTDeviceLinkFramingError(
            @"INCOMPLETE_FRAME",
            @"DeviceLink stream closed before the response completed");
      }
      return nil;
    }
    [output appendBytes:chunk.bytes length:(NSUInteger)count];
  }
  return output;
}

NSData *TUTDeviceLinkFrame(NSData *payload) {
  uint32_t size = CFSwapInt32HostToBig((uint32_t)payload.length);
  NSMutableData *framed =
      [NSMutableData dataWithBytes:&size length:sizeof(size)];
  [framed appendData:payload];
  return framed;
}

NSUInteger TUTDeviceLinkReadFrameSize(TUTMobileStream *stream,
                                      NSUInteger maximum, NSError **error) {
  NSData *header = TUTDeviceLinkReadFully(stream, sizeof(uint32_t), error);
  if (header == nil) {
    return 0;
  }
  uint32_t encoded = 0;
  [header getBytes:&encoded length:sizeof(encoded)];
  NSUInteger size = (NSUInteger)CFSwapInt32BigToHost(encoded);
  if (size == 0 || size > maximum) {
    if (error != NULL) {
      *error = TUTDeviceLinkFramingError(
          @"INVALID_FRAME", @"DeviceLink frame size is invalid");
    }
    return 0;
  }
  return size;
}
