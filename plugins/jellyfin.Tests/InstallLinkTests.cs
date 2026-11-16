using Xunit;

namespace Jellyfin.Plugin.SubsOnTime.Tests;

public class InstallLinkTests
{
    [Theory]
    [InlineData("https://subsontime.com/abc/manifest.json", "https://subsontime.com/abc")]
    [InlineData("  stremio://subsontime.com/abc/manifest.json\n", "https://subsontime.com/abc")]
    [InlineData("https://subsontime.com/abc/", "https://subsontime.com/abc")]
    [InlineData("http://localhost:3000/abc/manifest.json", "http://localhost:3000/abc")]
    public void NormalizesToTheAddonBase(string link, string addonBase)
    {
        Assert.Equal(addonBase, InstallLink.Normalize(link));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("subsontime.com/abc/manifest.json")]
    [InlineData("ftp://subsontime.com/abc/manifest.json")]
    public void RejectsAnythingElse(string link)
    {
        Assert.Null(InstallLink.Normalize(link));
    }
}
