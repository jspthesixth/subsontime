using System.Buffers.Binary;

namespace Jellyfin.Plugin.SubsOnTime;

public record VideoFingerprint(string Hash, long Size);

public static class OpenSubtitlesHash
{
    private const int ChunkBytes = 65536;

    public static async Task<VideoFingerprint?> ComputeAsync(Func<Stream> open, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var opening = Task.Run(() => Opened(open), CancellationToken.None);
        var owned = false;

        deadline.CancelAfter(timeout);

        try
        {
            var (stream, size) = await opening.WaitAsync(deadline.Token);

            owned = true;

            await using (stream)
            {
                var head = await ReadAsync(stream, 0, size, deadline.Token);
                var tail = await ReadAsync(stream, Math.Max(0, size - ChunkBytes), size, deadline.Token);
                var sum = unchecked(WordSum(head) + WordSum(tail) + (ulong)size);

                return new VideoFingerprint(sum.ToString("x16"), size);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        finally
        {
            if (!owned)
            {
                _ = opening.ContinueWith(task => task.Result.Stream.Dispose(), TaskContinuationOptions.OnlyOnRanToCompletion);
            }
        }
    }

    private static (Stream Stream, long Size) Opened(Func<Stream> open)
    {
        var stream = open();

        try
        {
            return (stream, stream.Length);
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    private static async Task<byte[]> ReadAsync(Stream stream, long start, long size, CancellationToken cancellationToken)
    {
        var chunk = new byte[Math.Min(ChunkBytes, size - start)];

        stream.Seek(start, SeekOrigin.Begin);
        await stream.ReadExactlyAsync(chunk, cancellationToken).AsTask().WaitAsync(cancellationToken);

        return chunk;
    }

    private static ulong WordSum(byte[] chunk) =>
        Enumerable.Range(0, chunk.Length / 8)
            .Aggregate(0UL, (sum, index) => unchecked(sum + BinaryPrimitives.ReadUInt64LittleEndian(chunk.AsSpan(index * 8))));
}
