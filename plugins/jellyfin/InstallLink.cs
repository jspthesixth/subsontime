namespace Jellyfin.Plugin.SubsOnTime;

public static class InstallLink
{
    public static string? Normalize(string link)
    {
        var trimmed = link.Trim();
        var web = trimmed.StartsWith("stremio://", StringComparison.OrdinalIgnoreCase)
            ? string.Concat("https://", trimmed.AsSpan("stremio://".Length))
            : trimmed;

        if (!Uri.TryCreate(web, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            return null;
        }

        var addonBase = uri.GetLeftPart(UriPartial.Path).TrimEnd('/');

        return addonBase.EndsWith("/manifest.json", StringComparison.Ordinal)
            ? addonBase[..^"/manifest.json".Length]
            : addonBase;
    }
}
