# CocoaPods intermittently fails while resolving pnpm-backed local Pod paths
# with `ArgumentError: pathname contains null byte`. Preserve CocoaPods'
# filesystem-group behavior without resolving those symlinks through
# Pathname#realdirpath.
module CocoaPodsPathnameWorkaround
  def group_for_path_in_group(
    absolute_pathname,
    group,
    reflect_file_system_structure,
    base_path = nil
  )
    unless absolute_pathname.absolute?
      raise ArgumentError, "Paths must be absolute #{absolute_pathname}"
    end
    unless base_path.nil? || base_path.absolute?
      raise ArgumentError, "Paths must be absolute #{base_path}"
    end

    relative_base = base_path.nil? ? group.real_path : base_path.cleanpath
    relative_pathname = absolute_pathname.relative_path_from(relative_base)
    relative_dir = relative_pathname.dirname

    if reflect_file_system_structure
      path = relative_base
      relative_dir.each_filename do |name|
        break if name.to_s.downcase.include? '.lproj'
        next if name == '.'

        path += name
        group = group.children.find { |child| child.display_name == name } ||
                group.new_group(name, path)
      end
    end

    if relative_dir.basename.to_s.downcase.include? '.lproj'
      group_name = variant_group_name(absolute_pathname)
      lproj_parent_dir = absolute_pathname.dirname.dirname
      group = @variant_groups_by_path_and_name[[lproj_parent_dir, group_name]] ||=
                group.new_variant_group(group_name, lproj_parent_dir)
    end

    group
  end
end

Pod::Project.prepend(CocoaPodsPathnameWorkaround)
