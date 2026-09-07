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
    raise 'Insecure ATS configuration' if info.dig('NSAppTransportSecurity', 'NSAllowsArbitraryLoads')
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
puts 'Project references, schemes, platform settings and HTTPS policy passed.'
