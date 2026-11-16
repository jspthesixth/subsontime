namespace Jellyfin.Plugin.SubsOnTime.Tests;

public static class TestFiles
{
    public static byte[] Generated(int size)
    {
        var state = 1u;

        return Enumerable.Range(0, size)
            .Select(_ =>
            {
                state = unchecked((state * 1103515245u) + 12345u);

                return (byte)((state >> 16) & 255);
            })
            .ToArray();
    }

    public static string Write(DirectoryInfo directory, string name, int size)
    {
        var path = Path.Combine(directory.FullName, name);

        File.WriteAllBytes(path, Generated(size));

        return path;
    }
}
