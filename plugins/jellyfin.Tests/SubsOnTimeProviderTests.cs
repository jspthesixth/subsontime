using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.Model.Globalization;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Jellyfin.Plugin.SubsOnTime.Tests;

public sealed class SubsOnTimeProviderTests : IDisposable
{
    private const string Listing = """
        {"subtitles":[
          {"id":"eng-1","lang":"eng","label":"OpenSubtitles (made for this file)","url":"https://subsontime.example/SEALED/sub/REF1.srt"},
          {"id":"hrv-1","lang":"hrv","label":"Titlovi.com","url":"https://subsontime.example/SEALED/sub/REF2.srt"},
          {"id":"deu-1","lang":"deu","label":"SubDL","url":"https://subsontime.example/SEALED/sub/REF3.srt"}
        ]}
        """;

    private const string Subtitle = "1\n00:00:01,000 --> 00:00:02,000\nThey're coming to get you, Barbara.\n";

    private static readonly Dictionary<string, CultureDto> Cultures = new()
    {
        ["eng"] = new CultureDto("en", "English", "en", ["eng"]),
        ["ger"] = new CultureDto("de", "German", "de", ["ger", "deu"]),
    };

    private readonly FakeServer server = new();
    private readonly RecordingLogger logger = new();
    private readonly DirectoryInfo directory = Directory.CreateTempSubdirectory("subsontime-");

    public void Dispose() => directory.Delete(true);

    private SubsOnTimeProvider ProviderWith(string installLink, string? seriesImdbId = null, TimeSpan? hashTimeout = null) =>
        new(
            () => new HttpClient(server, false),
            () => installLink,
            _ => seriesImdbId,
            language => Cultures.GetValueOrDefault(language),
            hashTimeout ?? TimeSpan.FromSeconds(5),
            logger);

    private SubsOnTimeProvider Provider() =>
        ProviderWith("  stremio://subsontime.example/SEALED/manifest.json ");

    private SubtitleSearchRequest MovieRequest(string language = "eng", string? mediaPath = null) => new()
    {
        Language = language,
        ContentType = VideoContentType.Movie,
        MediaPath = mediaPath ?? TestFiles.Write(directory, "Night of the Living Dead (1968).mkv", 204800),
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
            MediaPath = TestFiles.Write(directory, "Show S02E03.mkv", 204800),
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
    public async Task SearchesByFileNameWhenTheFileCannotBeRead()
    {
        await Provider().Search(MovieRequest(mediaPath: Path.Combine(directory.FullName, "Missing.mkv")), CancellationToken.None);

        Assert.Equal(["https://subsontime.example/SEALED/subtitles/movie/tt0063350/filename=Missing.mkv.json"], server.Requests);
        Assert.Equal(["Could not hash Missing.mkv, searching without the hash"], logger.Warnings);
    }

    [Fact]
    public async Task SearchesByFileNameWhenHashingTimesOut()
    {
        var path = Path.Combine(directory.FullName, "Slow Share.mkv");

        Assert.Equal(0, MakeFifo(path, Convert.ToUInt32("644", 8)));

        var provider = ProviderWith("https://subsontime.example/SEALED/manifest.json", hashTimeout: TimeSpan.FromMilliseconds(200));

        await provider.Search(MovieRequest(mediaPath: path), CancellationToken.None);

        Assert.Equal(["https://subsontime.example/SEALED/subtitles/movie/tt0063350/filename=Slow%20Share.mkv.json"], server.Requests);
        Assert.Equal(["Hashing Slow Share.mkv timed out, searching without the hash"], logger.Warnings);

        await using var writer = new FileStream(path, FileMode.Open, FileAccess.Write);
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
        Assert.False(result.Forced);
        Assert.DoesNotContain("SEALED", result.Id, StringComparison.Ordinal);
    }

    [Fact]
    public async Task KeepsTheLanguageJellyfinAskedFor()
    {
        var provider = Provider();
        var result = Assert.Single(await provider.Search(MovieRequest("ger"), CancellationToken.None));

        var response = await provider.GetSubtitles(result.Id, CancellationToken.None);

        Assert.Equal("German - SubDL", result.Name);
        Assert.Equal("ger", result.ThreeLetterISOLanguageName);
        Assert.Equal("ger", response.Language);
    }

    [Fact]
    public async Task MarksForeignPartsOnlySubtitlesForced()
    {
        server.Listing = """
            {"subtitles":[
              {"id":"eng-1","lang":"eng","label":"OpenSubtitles","url":"https://subsontime.example/SEALED/sub/REF1.srt"},
              {"id":"eng-forced","lang":"eng","label":"OpenSubtitles (foreign parts only)","url":"https://subsontime.example/SEALED/sub/REF5.srt"}
            ]}
            """;

        var provider = Provider();
        var results = (await provider.Search(MovieRequest(), CancellationToken.None)).ToList();

        var full = await provider.GetSubtitles(results[0].Id, CancellationToken.None);
        var forced = await provider.GetSubtitles(results[1].Id, CancellationToken.None);

        Assert.Equal([false, true], results.Select(result => result.Forced));
        Assert.False(full.IsForced);
        Assert.True(forced.IsForced);
        Assert.Equal("https://subsontime.example/SEALED/sub/REF5.srt", server.Requests.Last());
    }

    [Fact]
    public async Task KeepsEntriesFromAServerBehindAProxy()
    {
        server.Listing = """
            {"subtitles":[{"id":"eng-1","lang":"eng","label":"OpenSubtitles","url":"http://subsontime.internal:3000/SEALED/sub/REF6.srt?v=1"}]}
            """;

        var provider = Provider();
        var result = Assert.Single(await provider.Search(MovieRequest(), CancellationToken.None));

        await provider.GetSubtitles(result.Id, CancellationToken.None);

        Assert.Equal("https://subsontime.example/SEALED/sub/REF6.srt?v=1", server.Requests.Last());
    }

    [Fact]
    public async Task WarnsAboutEntriesOutsideTheInstallLink()
    {
        server.Listing = """
            {"subtitles":[
              {"id":"eng-1","lang":"eng","label":"OpenSubtitles","url":"https://subsontime.example/SEALED/sub/REF1.srt"},
              {"id":"eng-2","lang":"eng","label":"Elsewhere","url":"https://subsontime.example/OTHER/sub/REF4.srt"}
            ]}
            """;

        var results = await Provider().Search(MovieRequest(), CancellationToken.None);

        Assert.Equal(["English - OpenSubtitles"], results.Select(result => result.Name));
        Assert.Equal(["Dropped 1 subtitles outside the install link"], logger.Warnings);
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

    [DllImport("libc", EntryPoint = "mkfifo")]
    private static extern int MakeFifo(string path, uint mode);

    private sealed class FakeServer : HttpMessageHandler
    {
        public List<string> Requests { get; } = [];

        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;

        public string Listing { get; set; } = SubsOnTimeProviderTests.Listing;

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

    private sealed class RecordingLogger : ILogger
    {
        public List<string> Warnings { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (logLevel == LogLevel.Warning)
            {
                Warnings.Add(formatter(state, exception));
            }
        }
    }
}
