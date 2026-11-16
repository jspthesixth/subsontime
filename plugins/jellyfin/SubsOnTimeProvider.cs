using System.Buffers.Text;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Providers;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SubsOnTime;

public class SubsOnTimeProvider : ISubtitleProvider
{
    private static readonly TimeSpan HashTimeout = TimeSpan.FromSeconds(10);

    private readonly Func<HttpClient> createClient;
    private readonly Func<string> installLink;
    private readonly Func<string, string?> seriesImdbIdOf;
    private readonly Func<string, CultureDto?> findLanguage;
    private readonly ILogger logger;

    public SubsOnTimeProvider(
        IHttpClientFactory httpClientFactory,
        ILibraryManager libraryManager,
        ILocalizationManager localizationManager,
        ILogger<SubsOnTimeProvider> logger)
        : this(
            () => httpClientFactory.CreateClient(nameof(SubsOnTimeProvider)),
            () => Plugin.Instance?.Configuration.InstallLink ?? string.Empty,
            path => (libraryManager.FindByPath(path, false) as Episode)?.Series?.GetProviderId(MetadataProvider.Imdb),
            localizationManager.FindLanguageInfo,
            logger)
    {
    }

    internal SubsOnTimeProvider(
        Func<HttpClient> createClient,
        Func<string> installLink,
        Func<string, string?> seriesImdbIdOf,
        Func<string, CultureDto?> findLanguage,
        ILogger logger)
    {
        this.createClient = createClient;
        this.installLink = installLink;
        this.seriesImdbIdOf = seriesImdbIdOf;
        this.findLanguage = findLanguage;
        this.logger = logger;
    }

    public string Name => "Subs On Time";

    public IEnumerable<VideoContentType> SupportedMediaTypes => [VideoContentType.Movie, VideoContentType.Episode];

    public async Task<IEnumerable<RemoteSubtitleInfo>> Search(SubtitleSearchRequest request, CancellationToken cancellationToken)
    {
        var addonBase = InstallLink.Normalize(installLink());
        var videoId = string.IsNullOrEmpty(request.MediaPath) ? null : VideoIdOf(request);

        if (addonBase is null || videoId is null)
        {
            return [];
        }

        var fingerprint = await FingerprintOf(request.MediaPath, cancellationToken);
        var fileName = Uri.EscapeDataString(Path.GetFileName(request.MediaPath));
        var extras = fingerprint is null
            ? $"filename={fileName}"
            : $"videoHash={fingerprint.Hash}&videoSize={fingerprint.Size}&filename={fileName}";

        using var http = createClient();

        var listing = await http.GetFromJsonAsync<AddonListing>($"{addonBase}/subtitles/{videoId}/{extras}.json", JsonSerializerOptions.Web, cancellationToken);
        var culture = findLanguage(request.Language);
        var accepted = (culture?.ThreeLetterISOLanguageNames ?? []).Append(request.Language).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var languageName = culture?.DisplayName ?? request.Language;

        return (listing?.Subtitles ?? [])
            .Where(subtitle => accepted.Contains(subtitle.Lang) && subtitle.Url.StartsWith(addonBase + "/", StringComparison.Ordinal))
            .Select(subtitle => new RemoteSubtitleInfo
            {
                Id = $"{subtitle.Lang}-{Base64Url.EncodeToString(Encoding.UTF8.GetBytes(subtitle.Url[addonBase.Length..]))}",
                ProviderName = Name,
                Name = $"{languageName} - {subtitle.Label}",
                ThreeLetterISOLanguageName = subtitle.Lang,
                Format = "srt",
            })
            .ToList();
    }

    public async Task<SubtitleResponse> GetSubtitles(string id, CancellationToken cancellationToken)
    {
        var addonBase = InstallLink.Normalize(installLink())
            ?? throw new InvalidOperationException("Add the install link in the Subs On Time plugin settings.");
        var parts = id.Split('-', 2);
        var path = parts.Length == 2 ? Encoding.UTF8.GetString(Base64Url.DecodeFromChars(parts[1])) : string.Empty;

        if (!path.StartsWith('/'))
        {
            throw new ArgumentException("Unknown subtitle id.", nameof(id));
        }

        using var http = createClient();

        var bytes = await http.GetByteArrayAsync(addonBase + path, cancellationToken);

        return new SubtitleResponse { Format = "srt", Language = parts[0], Stream = new MemoryStream(bytes) };
    }

    private string? VideoIdOf(SubtitleSearchRequest request)
    {
        if (request.ContentType == VideoContentType.Movie)
        {
            var imdbId = request.GetProviderId(MetadataProvider.Imdb);

            return imdbId is null ? null : $"movie/{imdbId}";
        }

        var seriesImdbId = seriesImdbIdOf(request.MediaPath);

        return seriesImdbId is null || request.ParentIndexNumber is null || request.IndexNumber is null
            ? null
            : $"series/{seriesImdbId}:{request.ParentIndexNumber}:{request.IndexNumber}";
    }

    private async Task<VideoFingerprint?> FingerprintOf(string mediaPath, CancellationToken cancellationToken)
    {
        if (mediaPath.EndsWith(".strm", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var fingerprint = await OpenSubtitlesHash.ComputeAsync(() => File.OpenRead(mediaPath), HashTimeout, cancellationToken);

        if (fingerprint is null)
        {
            logger.LogWarning("Hashing {FileName} timed out, searching without the hash", Path.GetFileName(mediaPath));
        }

        return fingerprint;
    }

    private sealed record AddonListing(List<AddonSubtitle> Subtitles);

    private sealed record AddonSubtitle(string Id, string Lang, string Label, string Url);
}
