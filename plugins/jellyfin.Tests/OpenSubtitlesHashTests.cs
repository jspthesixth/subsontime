using System.Diagnostics;
using Xunit;

namespace Jellyfin.Plugin.SubsOnTime.Tests;

public class OpenSubtitlesHashTests
{
    [Theory]
    [InlineData(204800, "7e41b4dbe9b10c2e")]
    [InlineData(1000, "f90c876c5a7f1d56")]
    public async Task MatchesTheTypeScriptHash(int size, string hash)
    {
        var fingerprint = await OpenSubtitlesHash.ComputeAsync(
            () => new MemoryStream(TestFiles.Generated(size)),
            TimeSpan.FromSeconds(5),
            CancellationToken.None);

        Assert.Equal(new VideoFingerprint(hash, size), fingerprint);
    }

    [Fact]
    public async Task GivesUpOnAReadThatNeverCompletes()
    {
        var clock = Stopwatch.StartNew();

        var fingerprint = await OpenSubtitlesHash.ComputeAsync(
            () => new HungStream(),
            TimeSpan.FromMilliseconds(200),
            CancellationToken.None);

        Assert.Null(fingerprint);
        Assert.InRange(clock.Elapsed, TimeSpan.Zero, TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task GivesUpOnAnOpenThatNeverCompletes()
    {
        var fingerprint = await OpenSubtitlesHash.ComputeAsync(
            () =>
            {
                Thread.Sleep(Timeout.Infinite);

                return Stream.Null;
            },
            TimeSpan.FromMilliseconds(200),
            CancellationToken.None);

        Assert.Null(fingerprint);
    }

    [Fact]
    public async Task GivesUpOnASizeThatNeverArrives()
    {
        var fingerprint = await OpenSubtitlesHash.ComputeAsync(
            () => new HungLengthStream(),
            TimeSpan.FromMilliseconds(200),
            CancellationToken.None);

        Assert.Null(fingerprint);
    }

    [Fact]
    public async Task ClosesAFileThatOpensAfterTheTimeout()
    {
        var late = new DisposalStream();

        var fingerprint = await OpenSubtitlesHash.ComputeAsync(
            () =>
            {
                Thread.Sleep(500);

                return late;
            },
            TimeSpan.FromMilliseconds(100),
            CancellationToken.None);

        Assert.Null(fingerprint);
        await late.Disposed.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task StopsWhenTheCallerCancels()
    {
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OpenSubtitlesHash.ComputeAsync(
                () => new HungStream(),
                TimeSpan.FromMinutes(1),
                cancellation.Token));
    }

    [Fact]
    public async Task ReadsOnlyTheFirstAndLast64KB()
    {
        var stream = new CountingStream(TestFiles.Generated(10_000_000));

        await OpenSubtitlesHash.ComputeAsync(() => stream, TimeSpan.FromSeconds(5), CancellationToken.None);

        Assert.Equal(131072, stream.BytesRead);
    }

    private sealed class HungStream : MemoryStream
    {
        public HungStream()
            : base(new byte[204800])
        {
        }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            new(new TaskCompletionSource<int>().Task);

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            new TaskCompletionSource<int>().Task;

        public override int Read(Span<byte> buffer)
        {
            Thread.Sleep(Timeout.Infinite);

            return 0;
        }

        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
    }

    private sealed class HungLengthStream : MemoryStream
    {
        public override long Length
        {
            get
            {
                Thread.Sleep(Timeout.Infinite);

                return 0;
            }
        }
    }

    private sealed class DisposalStream : MemoryStream
    {
        public TaskCompletionSource Disposed { get; } = new();

        protected override void Dispose(bool disposing)
        {
            Disposed.TrySetResult();
            base.Dispose(disposing);
        }
    }

    private sealed class CountingStream(byte[] bytes) : MemoryStream(bytes)
    {
        public long BytesRead { get; private set; }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = base.Read(buffer, offset, count);

            BytesRead += read;

            return read;
        }
    }
}
