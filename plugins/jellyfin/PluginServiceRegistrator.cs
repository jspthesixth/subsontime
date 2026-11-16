using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Controller.Subtitles;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.SubsOnTime;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddHttpClient(nameof(SubsOnTimeProvider)).RemoveAllLoggers();
        serviceCollection.AddSingleton<ISubtitleProvider, SubsOnTimeProvider>();
    }
}
