using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SubsOnTime.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    public string InstallLink { get; set; } = string.Empty;
}
