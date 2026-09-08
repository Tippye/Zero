# frozen_string_literal: true
# gem install xcodeproj -v 1.27.0 (only needed when regenerating, not for opening/building)
require 'xcodeproj'
require 'fileutils'

root = File.expand_path('..', __dir__)
Dir.chdir(root)
project = Xcodeproj::Project.new('ZeroMail.xcodeproj')
project.root_object.attributes['LastUpgradeCheck'] = '1600'
project.root_object.known_regions = ['en', 'zh-Hans', 'Base']
package = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
package.relative_path = '.'
project.root_object.package_references << package
references = {}
def reference(project, references, path)
  references[path] ||= project.main_group.new_file(path)
end
def write_plist(path, content)
  FileUtils.mkdir_p(File.dirname(path))
  Xcodeproj::Plist.write_to_path(content, path)
end

common_info = {
  'CFBundleDisplayName' => 'Zero Mail', 'CFBundleName' => '$(PRODUCT_NAME)',
  'CFBundleIdentifier' => '$(PRODUCT_BUNDLE_IDENTIFIER)', 'CFBundleExecutable' => '$(EXECUTABLE_NAME)',
  'CFBundlePackageType' => 'APPL', 'CFBundleShortVersionString' => '$(MARKETING_VERSION)',
  'CFBundleVersion' => '$(CURRENT_PROJECT_VERSION)', 'CFBundleDevelopmentRegion' => 'zh_CN',
  'CFBundleURLTypes' => [{ 'CFBundleURLName' => 'org.zero.mail', 'CFBundleTypeRole' => 'Editor', 'CFBundleURLSchemes' => ['zeromail', 'mailto'] }],
  'NSUserActivityTypes' => ['org.zero.mail.read'],
  'NSAppTransportSecurity' => { 'NSAllowsArbitraryLoads' => false },
  'ITSAppUsesNonExemptEncryption' => false
}
write_plist('Configuration/macOS.entitlements', {
  'com.apple.security.app-sandbox' => true,
  'com.apple.security.network.client' => true,
  'com.apple.security.files.user-selected.read-write' => true
})
write_plist('Configuration/PrivacyInfo.xcprivacy', {
  'NSPrivacyTracking' => false, 'NSPrivacyTrackingDomains' => [], 'NSPrivacyCollectedDataTypes' => [],
  'NSPrivacyAccessedAPITypes' => [{ 'NSPrivacyAccessedAPIType' => 'NSPrivacyAccessedAPICategoryUserDefaults', 'NSPrivacyAccessedAPITypeReasons' => ['CA92.1'] }]
})

specs = [
  ['ZeroMac', :osx, '13.0', 'mac', 'macosx', '1'],
  ['ZeroIOS', :ios, '16.0', 'ios', 'iphoneos iphonesimulator', '1,2'],
  ['ZeroWatch', :watchos, '9.0', 'watch', 'watchos watchsimulator', '4']
]
specs.each do |name, platform, minimum, suffix, platforms, family|
  target = project.new_target(:application, name, platform, minimum)
  sources = Dir['Apps/Shared/*.swift'] + (platform == :watchos ? Dir['Apps/Watch/*.swift'] : Dir['Apps/Mail/*.swift'])
  target.add_file_references(sources.sort.map { |path| reference(project, references, path) })
  target.resources_build_phase.add_file_reference(reference(project, references, 'Configuration/PrivacyInfo.xcprivacy'))
  target.resources_build_phase.add_file_reference(reference(project, references, 'Configuration/Assets.xcassets'))
  if platform == :ios
    settings = reference(project, references, 'Configuration/Settings.bundle')
    settings.last_known_file_type = 'wrapper.plug-in'
    target.resources_build_phase.add_file_reference(settings)
  end
  %w[ZeroPairing ZeroMail].each do |product|
    dependency = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
    dependency.product_name = product
    dependency.package = package
    target.package_product_dependencies << dependency
    build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
    build_file.product_ref = dependency
    target.frameworks_build_phase.files << build_file
  end
  info = common_info.dup
  if platform == :osx
    info['LSApplicationCategoryType'] = 'public.app-category.productivity'
    info['NSPrincipalClass'] = 'NSApplication'
  elsif platform == :ios
    info['LSRequiresIPhoneOS'] = true
    info['UILaunchScreen'] = {}
    info['UIApplicationSceneManifest'] = { 'UIApplicationSupportsMultipleScenes' => true }
    info['UISupportedInterfaceOrientations'] = ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight']
    info['UISupportedInterfaceOrientations~ipad'] = info['UISupportedInterfaceOrientations'] + ['UIInterfaceOrientationPortraitUpsideDown']
  else
    info['WKApplication'] = true
    info['WKWatchOnly'] = true
  end
  plist = "Configuration/#{name}-Info.plist"
  write_plist(plist, info)
  reference(project, references, plist)
  debug_plist = "Configuration/#{name}-Debug-Info.plist"
  debug_info = info.merge('NSAppTransportSecurity' => {
    'NSAllowsArbitraryLoads' => false,
    'NSAllowsLocalNetworking' => true,
    'NSExceptionDomains' => { 'localhost' => { 'NSExceptionAllowsInsecureHTTPLoads' => true, 'NSIncludesSubdomains' => false } }
  })
  write_plist(debug_plist, debug_info)
  reference(project, references, debug_plist)
  target.build_configurations.each do |config|
    config.build_settings.merge!({
      'PRODUCT_BUNDLE_IDENTIFIER' => "org.zero.mail.#{suffix}", 'PRODUCT_NAME' => name,
      'SWIFT_VERSION' => '5.0', 'SWIFT_STRICT_CONCURRENCY' => 'targeted',
      'MARKETING_VERSION' => '0.1.0', 'CURRENT_PROJECT_VERSION' => '1',
      'INFOPLIST_FILE' => config.name == 'Debug' ? debug_plist : plist, 'GENERATE_INFOPLIST_FILE' => 'NO',
      'CODE_SIGN_STYLE' => 'Automatic', 'SUPPORTED_PLATFORMS' => platforms,
      'TARGETED_DEVICE_FAMILY' => family, 'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES',
      'SWIFT_EMIT_LOC_STRINGS' => 'YES'
    })
    config.build_settings['ASSETCATALOG_COMPILER_APPICON_NAME'] = platform == :osx ? 'MacIcon' : platform == :watchos ? 'WatchIcon' : 'AppIcon'
    if platform == :osx
      config.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'Configuration/macOS.entitlements'
      config.build_settings['ENABLE_HARDENED_RUNTIME'] = 'YES'
    elsif platform == :ios
      config.build_settings['SUPPORTS_MACCATALYST'] = 'NO'
      config.build_settings['SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD'] = 'NO'
    end
  end
  scheme = Xcodeproj::XCScheme.new
  scheme.add_build_target(target)
  scheme.set_launch_target(target)
  unless platform == :watchos
    tests = project.new_target(:ui_test_bundle, name + 'UITests', platform, minimum)
    tests.add_file_references(Dir['Tests/AppUITests/*.swift'].sort.map { |path| reference(project, references, path) })
    tests.add_dependency(target)
    tests.build_configurations.each do |config|
      config.build_settings.merge!({ 'PRODUCT_BUNDLE_IDENTIFIER' => "org.zero.mail.#{suffix}.uitests", 'SWIFT_VERSION' => '5.0', 'GENERATE_INFOPLIST_FILE' => 'YES', 'TEST_TARGET_NAME' => name, 'CODE_SIGN_STYLE' => 'Automatic', 'SUPPORTED_PLATFORMS' => platforms, 'TARGETED_DEVICE_FAMILY' => family })
    end
    scheme.add_test_target(tests)
  end
  scheme.save_as(project.path, name, true)
end
require_relative 'generate-extensions'
add_zero_extensions(project, references, package)
project.predictabilize_uuids
project.save
# Rewrite scheme UUIDs after deterministic project UUID conversion.
project.targets.select { |t| specs.map(&:first).include?(t.name) }.each do |target|
  scheme = Xcodeproj::XCScheme.new
  scheme.add_build_target(target); scheme.set_launch_target(target)
  tests = project.targets.find { |t| t.name == target.name + 'UITests' }
  scheme.add_test_target(tests) if tests
  scheme.save_as(project.path, target.name, true)
end
puts 'Generated ZeroMail.xcodeproj: ZeroMac, ZeroIOS (iPhone + iPad), ZeroWatch'
