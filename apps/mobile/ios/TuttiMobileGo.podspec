Pod::Spec.new do |spec|
  spec.name = 'TuttiMobileGo'
  spec.version = '0.1.0'
  spec.summary = 'Tutti Mobile DeviceLink and Agent live gomobile bindings'
  spec.homepage = 'https://github.com/tutti-os/tutti'
  spec.license = { :type => 'Apache-2.0' }
  spec.author = 'Tutti'
  spec.platform = :ios, '15.1'
  spec.source = { :git => 'https://github.com/tutti-os/tutti.git', :tag => spec.version.to_s }
  spec.vendored_frameworks = 'Frameworks/TuttiMobileGo.xcframework'
end
