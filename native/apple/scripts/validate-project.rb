require 'xcodeproj'
require 'rexml/document'
Dir.chdir(File.expand_path('..', __dir__))
project = Xcodeproj::Project.open('ZeroMail.xcodeproj')
expected = %w[ZeroMac ZeroIOS ZeroWatch]
raise 'Missing application targets' unless expected.all? { |name| project.targets.any? { |t| t.name == name } }
project.targets.each do |target|
  target.source_build_phase.files_references.each { |file| raise "Missing source: #{file.real_path}" unless file.real_path.file? }
  target.build_configurations.each do |config|
    path = config.build_settings['INFOPLIST_FILE']
    next unless path
    info = Xcodeproj::Plist.read_from_path(path)
    raise 'Watch-only and companion-independent modes are mutually exclusive' if info['WKWatchOnly'] && info['WKRunsIndependentlyOfCompanionApp']
    raise 'Insecure ATS configuration' if info.dig('NSAppTransportSecurity', 'NSAllowsArbitraryLoads')
    if config.name == 'Release'
      ats = info['NSAppTransportSecurity'] || {}
      raise 'Release must not permit development HTTP' if ats['NSAllowsLocalNetworking'] || ats['NSExceptionDomains']
    end
  end
end
expected.each do |name|
  scheme = REXML::Document.new(File.read("ZeroMail.xcodeproj/xcshareddata/xcschemes/#{name}.xcscheme"))
  REXML::XPath.each(scheme, '//BuildableReference') do |item|
    raise "Invalid scheme target: #{name}" unless project.objects_by_uuid[item.attributes['BlueprintIdentifier']]
  end
end
watch = Xcodeproj::Plist.read_from_path('Configuration/ZeroWatch-Info.plist')
raise 'Watch must support independent pairing' unless watch['WKApplication'] && watch['WKWatchOnly']
settings_path = 'Configuration/Settings.bundle'
raise 'Missing Settings.bundle directory' unless File.directory?(settings_path)
project.targets.each do |target|
  settings = target.resources_build_phase.files_references.select { |file| file.path == settings_path }
  raise "Settings.bundle resource must belong only to ZeroIOS: #{target.name}" unless settings.length == (target.name == 'ZeroIOS' ? 1 : 0)
  settings.each do |file|
    raise 'Settings.bundle must be copied as one bundle directory' unless file.last_known_file_type == 'wrapper.plug-in' && file.real_path.directory?
  end
  raise 'Settings.bundle children must not be flattened into app resources' if target.resources_build_phase.files_references.any? { |file| file.path&.start_with?(settings_path + '/') }
end
settings = Xcodeproj::Plist.read_from_path(settings_path + '/Root.plist')
raise 'Settings must use the standard app preferences domain' unless settings.keys.sort == %w[PreferenceSpecifiers StringsTable]
raise 'Settings localization table must be Root' unless settings['StringsTable'] == 'Root'
expected_preferences = {
  'zero.mail.previewLines' => 2, 'zero.mail.markReadOnOpen' => true,
  'zero.mail.confirmBeforeTrash' => false, 'zero.mail.showAccountAddress' => true,
  'zero.notifications.preview' => false, 'zero.notifications.sound' => true
}
rows = settings.fetch('PreferenceSpecifiers')
controls = rows.select { |row| row.key?('Key') }
raise 'Settings keys must match the public mail preference contract' unless controls.length == expected_preferences.length && controls.map { |row| row['Key'] }.sort == expected_preferences.keys.sort
labels = []
rows.each do |row|
  raise 'Unsupported Settings control' unless %w[PSGroupSpecifier PSMultiValueSpecifier PSToggleSwitchSpecifier].include?(row['Type'])
  labels += [row['Title'], row['FooterText']].compact + (row['Titles'] || [])
  next unless row['Key']
  key = row['Key']
  raise "Mismatched preference default: #{key}" unless row['DefaultValue'] == expected_preferences.fetch(key)
  if key == 'zero.mail.previewLines'
    raise 'Preview must provide the six integer line choices' unless row['Type'] == 'PSMultiValueSpecifier' && row['Values'] == (0..5).to_a && row['Titles']&.length == 6
  else
    raise "Boolean preference must use a standard toggle: #{key}" unless row['Type'] == 'PSToggleSwitchSpecifier' && [true, false].include?(row['DefaultValue']) && !row.key?('TrueValue') && !row.key?('FalseValue')
  end
end
%w[en zh-Hans].each do |language|
  # A .strings file is an OpenStep dictionary without the enclosing braces.
  strings = Nanaimo::Reader.new("{\n" + File.read("#{settings_path}/#{language}.lproj/Root.strings") + "\n}").parse!.as_ruby
  raise "Incomplete Settings localization: #{language}" unless strings.keys.sort == labels.uniq.sort && strings.values.all? { |value| value.is_a?(String) && !value.empty? }
  raise "Incorrect zero-line label: #{language}" unless strings['PREVIEW_NONE'] == (language == 'en' ? 'None' : '无')
end
puts 'Project references, schemes, platform settings, HTTPS policy and Settings.bundle contract passed.'
