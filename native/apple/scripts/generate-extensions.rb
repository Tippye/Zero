# frozen_string_literal: true

# Called after containing application targets exist and before UUID normalization.
def add_zero_extensions(project, references, package)
  app_group = 'group.org.zero.mail'
  extensions = [
    ['ZeroIOSShare', 'ZeroIOS', :ios, '16.0', 'ios.share', 'iphoneos iphonesimulator', '1,2', 'Extensions/Share/ShareViewController.swift', 'com.apple.share-services'],
    ['ZeroIOSWidgets', 'ZeroIOS', :ios, '16.0', 'ios.widgets', 'iphoneos iphonesimulator', '1,2', 'Extensions/Widgets/ZeroMailWidgets.swift', 'com.apple.widgetkit-extension'],
    ['ZeroMacWidgets', 'ZeroMac', :osx, '13.0', 'mac.widgets', 'macosx', '1', 'Extensions/Widgets/ZeroMailWidgets.swift', 'com.apple.widgetkit-extension'],
    ['ZeroWatchWidgets', 'ZeroWatch', :watchos, '9.0', 'watch.widgets', 'watchos watchsimulator', '4', 'Extensions/Widgets/ZeroMailWidgets.swift', 'com.apple.widgetkit-extension']
  ]
  extensions.each do |name, parent_name, platform, minimum, suffix, platforms, family, source, point|
    parent = project.targets.find { |target| target.name == parent_name }
    raise "Missing containing target #{parent_name}" unless parent

    parent.build_configurations.each do |config|
      path = config.build_settings['CODE_SIGN_ENTITLEMENTS'] || "Configuration/#{parent_name}.entitlements"
      content = File.exist?(path) ? Xcodeproj::Plist.read_from_path(path) : {}
      content['com.apple.security.application-groups'] = [app_group]
      write_plist(path, content)
      config.build_settings['CODE_SIGN_ENTITLEMENTS'] = path
      config.build_settings['REGISTER_APP_GROUPS'] = 'YES'
    end

    target = project.new_target(:app_extension, name, platform, minimum)
    target.add_file_references([reference(project, references, source)])
    target.resources_build_phase.add_file_reference(reference(project, references, 'Configuration/PrivacyInfo.xcprivacy'))
    dependency = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
    dependency.product_name = 'ZeroMail'; dependency.package = package
    target.package_product_dependencies << dependency
    build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
    build_file.product_ref = dependency
    target.frameworks_build_phase.files << build_file

    extension = { 'NSExtensionPointIdentifier' => point }
    if point == 'com.apple.share-services'
      extension['NSExtensionPrincipalClass'] = '$(PRODUCT_MODULE_NAME).ShareViewController'
      extension['NSExtensionAttributes'] = {
        'NSExtensionActivationRule' => {
          'NSExtensionActivationSupportsText' => true,
          'NSExtensionActivationSupportsWebURLWithMaxCount' => 20,
          'NSExtensionActivationSupportsFileWithMaxCount' => 20,
          'NSExtensionActivationSupportsImageWithMaxCount' => 20
        }
      }
    end
    info = {
      'CFBundleDisplayName' => point == 'com.apple.share-services' ? 'Zero Mail' : 'Zero Mail Widgets',
      'CFBundleName' => '$(PRODUCT_NAME)', 'CFBundleIdentifier' => '$(PRODUCT_BUNDLE_IDENTIFIER)',
      'CFBundleExecutable' => '$(EXECUTABLE_NAME)', 'CFBundlePackageType' => 'XPC!',
      'CFBundleShortVersionString' => '$(MARKETING_VERSION)', 'CFBundleVersion' => '$(CURRENT_PROJECT_VERSION)',
      'CFBundleDevelopmentRegion' => 'zh_CN', 'NSExtension' => extension,
      'ITSAppUsesNonExemptEncryption' => false
    }
    plist = "Configuration/#{name}-Info.plist"
    write_plist(plist, info)
    entitlement_path = "Configuration/#{name}.entitlements"
    entitlements = { 'com.apple.security.application-groups' => [app_group] }
    entitlements['com.apple.security.app-sandbox'] = true if platform == :osx
    write_plist(entitlement_path, entitlements)
    target.build_configurations.each do |config|
      config.build_settings.merge!({
        'PRODUCT_BUNDLE_IDENTIFIER' => "org.zero.mail.#{suffix}", 'PRODUCT_NAME' => name,
        'SWIFT_VERSION' => '5.0', 'SWIFT_STRICT_CONCURRENCY' => 'targeted',
        'MARKETING_VERSION' => '0.1.0', 'CURRENT_PROJECT_VERSION' => '1',
        'INFOPLIST_FILE' => plist, 'GENERATE_INFOPLIST_FILE' => 'NO',
        'CODE_SIGN_STYLE' => 'Automatic', 'CODE_SIGN_ENTITLEMENTS' => entitlement_path,
        'REGISTER_APP_GROUPS' => 'YES', 'SUPPORTED_PLATFORMS' => platforms,
        'TARGETED_DEVICE_FAMILY' => family, 'APPLICATION_EXTENSION_API_ONLY' => 'YES',
        'SKIP_INSTALL' => 'YES', 'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES'
      })
    end
    parent.add_dependency(target)
    embed = parent.copy_files_build_phases.find { |phase| phase.name == 'Embed App Extensions' } || parent.new_copy_files_build_phase('Embed App Extensions')
    embed.dst_subfolder_spec = '13'
    embedded = embed.add_file_reference(target.product_reference)
    embedded.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  end
end
