package tv.pqtv.player

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.*
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var fullscreenContainer: FrameLayout
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var pendingApkFile: File? = null
    private var isDownloading = false

    private val baseUrl: String
        get() {
            val prefs = getSharedPreferences("pqtv_prefs", MODE_PRIVATE)
            val saved = prefs.getString("server_url", null)
            val configured = if (!saved.isNullOrBlank()) saved else BuildConfig.PQTV_SERVER_URL
            return configured.trimEnd('/')
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val root = FrameLayout(this)
        webView = WebView(this)
        fullscreenContainer = FrameLayout(this).apply {
            visibility = View.GONE
            setBackgroundColor(android.graphics.Color.BLACK)
        }
        root.addView(webView)
        root.addView(fullscreenContainer)
        setContentView(root)

        hideSystemUi()
        setupWebView()
        webView.loadUrl("$baseUrl/watch")

        // Automatic background OTA update check when TV launches app
        checkForUpdatesNative(showUpToDateToast = false)
    }

    private fun hideSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.setAcceptThirdPartyCookies(webView, true)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            useWideViewPort = true
            loadWithOverviewMode = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            // Clean Chrome-like UA so Google Sign-In works cleanly without Disallowed User-Agent blocks
            userAgentString = "Mozilla/5.0 (Linux; Android ${Build.VERSION.RELEASE}; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 PQTV-APK/${BuildConfig.VERSION_NAME}"
        }

        webView.addJavascriptInterface(AndroidBridge(), "PQTVAndroid")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                if (url.endsWith(".apk")) {
                    downloadAndInstallApk(url, "latest")
                    return true
                }
                return false
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                CookieManager.getInstance().flush()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (customView != null) {
                    callback?.onCustomViewHidden()
                    return
                }
                customView = view
                customViewCallback = callback
                fullscreenContainer.addView(view)
                fullscreenContainer.visibility = View.VISIBLE
                webView.visibility = View.GONE
            }

            override fun onHideCustomView() {
                fullscreenContainer.removeAllViews()
                fullscreenContainer.visibility = View.GONE
                customView = null
                customViewCallback?.onCustomViewHidden()
                webView.visibility = View.VISIBLE
                hideSystemUi()
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
            if (customView != null) {
                webView.webChromeClient?.onHideCustomView()
                return true
            }
            webView.evaluateJavascript(
                "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));",
                null
            )
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_UNKNOWN_SOURCES) {
            pendingApkFile?.let { file ->
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()) {
                    launchApkInstaller(file)
                } else {
                    Toast.makeText(this, "Разрешите установку обновлений для PQTV", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    inner class AndroidBridge {
        @JavascriptInterface
        fun isAndroidTV(): Boolean = true

        @JavascriptInterface
        fun getVersionCode(): Int = BuildConfig.VERSION_CODE

        @JavascriptInterface
        fun getVersionName(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun checkForUpdate() {
            runOnUiThread { checkForUpdatesNative(showUpToDateToast = true) }
        }

        @JavascriptInterface
        fun installUpdate(apkUrl: String, versionName: String) {
            runOnUiThread {
                val resolved = if (apkUrl.startsWith("http")) apkUrl else "$baseUrl$apkUrl"
                downloadAndInstallApk(resolved, versionName)
            }
        }

        @JavascriptInterface
        fun setServerUrl(url: String) {
            val clean = url.trim().trimEnd('/')
            if (clean.startsWith("http://") || clean.startsWith("https://")) {
                getSharedPreferences("pqtv_prefs", MODE_PRIVATE).edit().putString("server_url", clean).apply()
                runOnUiThread { webView.loadUrl("$clean/watch") }
            }
        }
    }

    private fun checkForUpdatesNative(showUpToDateToast: Boolean) {
        thread {
            try {
                val conn = (URL("$baseUrl/api/app/version?currentCode=${BuildConfig.VERSION_CODE}").openConnection() as HttpURLConnection).apply {
                    connectTimeout = 8000
                    readTimeout = 8000
                }
                val body = conn.inputStream.bufferedReader().readText()
                conn.disconnect()
                val json = JSONObject(body)
                val latest = json.optJSONObject("latest") ?: run {
                    if (showUpToDateToast) runOnUiThread {
                        Toast.makeText(this, "Нет опубликованных APK обновлений", Toast.LENGTH_SHORT).show()
                    }
                    return@thread
                }
                val remoteCode = latest.optInt("versionCode", 0)
                val remoteName = latest.optString("versionName", "")
                val apkUrl = latest.optString("apkUrl", "/apk/latest.apk")
                val changelog = latest.optString("changelog", "")
                val mandatory = latest.optBoolean("mandatory", false)

                runOnUiThread {
                    emitJsEvent("window.onPQTVUpdateInfo && window.onPQTVUpdateInfo(${json})")
                    if (remoteCode > BuildConfig.VERSION_CODE) {
                        val resolvedUrl = if (apkUrl.startsWith("http")) apkUrl else "$baseUrl$apkUrl"
                        val msg = StringBuilder("Доступна новая версия PQTV $remoteName (текущая ${BuildConfig.VERSION_NAME})")
                        if (changelog.isNotBlank()) msg.append("\n\nЧто нового:\n").append(changelog)
                        val builder = AlertDialog.Builder(this)
                            .setTitle("Обновление PQTV")
                            .setMessage(msg.toString())
                            .setPositiveButton("Установить сейчас") { _, _ ->
                                downloadAndInstallApk(resolvedUrl, remoteName)
                            }
                        if (!mandatory) {
                            builder.setNegativeButton("Позже", null)
                        } else {
                            builder.setCancelable(false)
                        }
                        builder.show()
                    } else if (showUpToDateToast) {
                        Toast.makeText(this, "Установлена актуальная версия ${BuildConfig.VERSION_NAME}", Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (_: Exception) {
                if (showUpToDateToast) {
                    runOnUiThread {
                        Toast.makeText(this, "Не удалось проверить обновления", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }

    private fun downloadAndInstallApk(apkUrl: String, versionName: String) {
        if (isDownloading) return
        isDownloading = true
        runOnUiThread {
            Toast.makeText(this, "Загрузка обновления PQTV $versionName...", Toast.LENGTH_SHORT).show()
            emitJsEvent("window.onPQTVDownloadProgress && window.onPQTVDownloadProgress(0, 'downloading')")
        }
        thread {
            try {
                val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: File(filesDir, "apk")
                if (!dir.exists()) dir.mkdirs()
                val outFile = File(dir, "pqtv-update.apk")
                if (outFile.exists()) outFile.delete()

                val conn = (URL(apkUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15000
                    readTimeout = 30000
                    instanceFollowRedirects = true
                }
                val total = conn.contentLengthLong.coerceAtLeast(1L)
                var downloaded = 0L
                var lastPct = -1

                conn.inputStream.use { input ->
                    FileOutputStream(outFile).use { output ->
                        val buf = ByteArray(16 * 1024)
                        while (true) {
                            val read = input.read(buf)
                            if (read <= 0) break
                            output.write(buf, 0, read)
                            downloaded += read
                            val pct = ((downloaded * 100) / total).toInt().coerceIn(0, 100)
                            if (pct != lastPct) {
                                lastPct = pct
                                runOnUiThread {
                                    emitJsEvent("window.onPQTVDownloadProgress && window.onPQTVDownloadProgress($pct, 'downloading')")
                                }
                            }
                        }
                    }
                }
                conn.disconnect()

                runOnUiThread {
                    isDownloading = false
                    emitJsEvent("window.onPQTVDownloadProgress && window.onPQTVDownloadProgress(100, 'ready')")
                    installApkFile(outFile)
                }
            } catch (e: Exception) {
                runOnUiThread {
                    isDownloading = false
                    emitJsEvent("window.onPQTVDownloadProgress && window.onPQTVDownloadProgress(-1, 'error')")
                    Toast.makeText(this, "Ошибка загрузки обновления: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun installApkFile(file: File) {
        pendingApkFile = file
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(this)
                .setTitle("Разрешение на обновление")
                .setMessage("Разрешите PQTV устанавливать обновления приложений на этом телевизоре.")
                .setPositiveButton("Открыть настройки") { _, _ ->
                    val intent = Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:$packageName")
                    )
                    @Suppress("DEPRECATION")
                    startActivityForResult(intent, REQ_UNKNOWN_SOURCES)
                }
                .setNegativeButton("Отмена", null)
                .show()
            return
        }
        launchApkInstaller(file)
    }

    private fun launchApkInstaller(file: File) {
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(intent)
    }

    private fun emitJsEvent(script: String) {
        webView.evaluateJavascript(script, null)
    }

    companion object {
        private const val REQ_UNKNOWN_SOURCES = 4201
    }
}
