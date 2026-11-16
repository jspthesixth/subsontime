using System.Buffers.Binary;

namespace Jellyfin.Plugin.SubsOnTime;

public record VideoFingerprint(string Hash, long Size);

public static class OpenSubtitlesHash
{
    private const int ChunkBytes = 65536;

    public static async Task<VideoFingerprint?> ComputeAsync(Func<Stream> open, TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        deadline.CancelAfter(timeout);

        try
        {
            await using var stream = await Task.Run(open, CancellationToken.None).WaitAsync(deadline.Token);
            var size = stream.Length;
            var head = await ReadAsync(stream, 0, deadline.Token);
            var tail = await ReadAsync(stream, Math.Max(0, size - ChunkBytes), deadline.Token);
            var sum = unchecked(WordSum(head) + WordSum(tail) + (ulong)size);

            return new VideoFingerprint(sum.ToString("x16"), size);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
    }

    private static async Task<byte[]> ReadAsync(Stream stream, long start, CancellationToken cancellationToken)
    {
        var chunk = new byte[Math.Min(ChunkBytes, stream.Length - start)];

        stream.Seek(start, SeekOrigin.Begin);
        await stream.ReadExactlyAsync(chunk, cancellationToken).AsTask().WaitAsync(cancellationToken);

        return chunk;
    }

    private static ulong WordSum(byte[] chunk) =>
        Enumerable.Range(0, chunk.Length / 8)
            .Aggregate(0UL, (sum, index) => unchecked(sum + BinaryPrimitives.ReadUInt64LittleEndian(chunk.AsSpan(index * 8))));
}
