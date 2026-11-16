using System.Net;
using System.Text;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.Model.Globalization;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.SubsOnTime.Tests;

public class SubsOnTimeProviderTests
{
    private const string Listing = """
        {"subtitles":[
          {"id":"eng-1","lang":"eng","label":"OpenSubtitles (made for this file)","url":"https://subsontime.example/SEALED/sub/REF1.srt"},
          {"id":"hrv-1","lang":"hrv","label":"Titlovi.com","url":"https://subsontime.example/SEALED/sub/REF2.srt"},
          {"id":"deu-1","lang":"deu","label":"SubDL","url":"https://subsontime.example/SEALED/sub/REF3.srt"},
          {"id":"eng-2","lang":"eng","label":"Elsewhere","url":"https://elsewhere.example/sub/REF4.srt"}
        ]}
        """;

    private const string Subtitle = "1\n00:00:01,000 --> 00:00:02,000\nThey're coming to get you, Barbara.\n";

    private static readonly Dictionary<string, CultureDto> Cultures = new()
    {
        ["eng"] = new CultureDto("en", "English", "en", ["eng"]),
        ["ger"] = new CultureDto("de", "German", "de", ["ger", "deu"]),
    };

    private readonly FakeServer server = new();

    private SubsOnTimeProvider ProviderWith(string installLink, string? seriesImdbId = null) =>
        new(
            () => new HttpClient(server, false),
            () => installLink,
            _ => seriesImdbId,
            language => Cultures.GetValueOrDefault(language),
            NullLogger.Instance);

    private SubsOnTimeProvider Provider() =>
        ProviderWith("  stremio://subsontime.example/SEALED/manifest.json ");

    private static SubtitleSearchRequest MovieRequest(string language = "eng") => new()
    {
        Language = language,
        ContentType = VideoContentType.Movie,
        MediaPath = TestFiles.Write("Night of the Living Dead (1968).mkv", 204800),
        ProviderIds = new Dictionary<string, string> { ["Imdb"] = "tt0063350" },
    };

    [Fact]
    public async Task SearchesAMovieByHashSizeAndFileName()
    {
        await Provider().Search(MovieRequest(), CancellationToken.None);

        Assert.Equal(
            ["https://subsontime.example/SEALED/subtitles/movie/tt0063350/videoHash=7e41b4dbe9b10c2e&videoSize=204800&filename=Night%20of%20the%20Living%20Dead%20%281968%29.mkv.json"],
            server.Requests);
    }

    [Fact]
    public async Task SearchesAnEpisodeByTheSeriesImdbId()
    {
        var request = new SubtitleSearchRequest
        {
            Language = "eng",
            ContentType = VideoContentType.Episode,
            MediaPath = TestFiles.Write("Show S02E03.mkv", 204800),
            ParentIndexNumber = 2,
            IndexNumber = 3,
            ProviderIds = new Dictionary<string, string> { ["Imdb"] = "tt9999999" },
        };

        await ProviderWith("https://subsontime.example/SEALED/manifest.json", "tt0000001").Search(request, CancellationToken.None);

        Assert.Equal(
            ["https://subsontime.example/SEALED/subtitles/series/tt0000001:2:3/videoHash=7e41b4dbe9b10c2e&videoSize=204800&filename=Show%20S02E03.mkv.json"],
            server.Requests);
    }

    [Fact]
    public async Task MapsTheRequestedLanguageToReadableResults()
    {
        var results = (await Provider().Search(MovieRequest(), CancellationToken.None)).ToList();

        var result = Assert.Single(results);
        Assert.Equal("English - OpenSubtitles (made for this file)", result.Name);
        Assert.Equal("eng", result.ThreeLetterISOLanguageName);
        Assert.Equal("srt", result.Format);
        Assert.Equal("Subs On Time", result.ProviderName);
        Assert.DoesNotContain("SEALED", result.Id, StringComparison.Ordinal);
    }

    [Fact]
    public async Task MatchesTheBibliographicLanguageCode()
    {
        var results = await Provider().Search(MovieRequest("ger"), CancellationToken.None);

        Assert.Equal(["German - SubDL"], results.Select(result => result.Name));
    }

    [Fact]
    public async Task DownloadsTheSubtitleFromTheInstallLink()
    {
        var provider = Provider();
        var result = Assert.Single(await provider.Search(MovieRequest(), CancellationToken.None));

        var response = await provider.GetSubtitles(result.Id, CancellationToken.None);

        Assert.Equal("https://subsontime.example/SEALED/sub/REF1.srt", server.Requests.Last());
        Assert.Equal("eng", response.Language);
        Assert.Equal("srt", response.Format);
        Assert.Equal(Subtitle, await new StreamReader(response.Stream).ReadToEndAsync());
    }

    [Fact]
    public async Task SearchesNothingWithoutAnInstallLink()
    {
        var results = await ProviderWith(" ").Search(MovieRequest(), CancellationToken.None);

        Assert.Empty(results);
        Assert.Empty(server.Requests);
    }

    [Fact]
    public async Task KeepsTheInstallLinkOutOfErrors()
    {
        var provider = Provider();
        var result = Assert.Single(await provider.Search(MovieRequest(), CancellationToken.None));

        server.Status = HttpStatusCode.InternalServerError;

        var searchError = await Assert.ThrowsAnyAsync<Exception>(() => provider.Search(MovieRequest(), CancellationToken.None));
        var downloadError = await Assert.ThrowsAnyAsync<Exception>(() => provider.GetSubtitles(result.Id, CancellationToken.None));

        Assert.DoesNotContain("SEALED", searchError.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain("SEALED", downloadError.ToString(), StringComparison.Ordinal);
    }

    private sealed class FakeServer : HttpMessageHandler
    {
        public List<string> Requests { get; } = [];

        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!.AbsoluteUri;
            var body = uri.Contains("/subtitles/", StringComparison.Ordinal) ? Listing : Subtitle;

            Requests.Add(uri);

            return Task.FromResult(new HttpResponseMessage(Status)
            {
                Content = new StringContent(body, Encoding.UTF8),
            });
        }
    }
}
