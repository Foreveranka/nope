# NOPE — Network of Private Execution

NEAR üzerinde gizli tekliflerle iş satın alma ve müşteri verisini açık hâliyle yürütücüye vermeden hesaplatma projesinin uygulaması.

Uygulama dört sayısal kaydı gerçek Concrete FHE ile işler. Kayıt kimliklerinin tekrarlarını işaretler, eksik değer kodunu sıfıra çevirir ve 100 üstü değerleri sınırlar. Python istemci açık veriyi ve secret key'i kendi belleğinde tutar; ayrı evaluator şifreli isteği işler. Yerel akışa ek olarak davetle erişilen Vercel hesaplama yolu vardır. Bu sürüm genel amaçlı veri temizleme veya tamamlanmış ticari ödeme ürünü değildir.

Marka adı NOPE olarak güncellendi. Mevcut GitHub/Vercel adresleri ve `VEIL_*` yapılandırma adları bağlantı uyumluluğu için korunur. Yeni indirme adı `nope-client.zip`; eski indirme bağlantısı da çalışır.

## Tek akışlı Privacy demosu

[Privacy demosu](https://veil-procurement.vercel.app/privacy) tamamlanmış gerçek
koşumun kanıtlarını gösterir. Yapılandırılmış operatör bilgisayarında
`.venv/bin/python scripts/privacy-demo-launch.py` ile açılan yerel sayfa,
tek düğmeyle gerçek FHE → MPC → NEAR testnet kabulü → escrow ödemesi yürütür.
Bu kontrollü sentetik demo, bağımsız operatörlü genel müşteri pazarı değildir.
[Başlatma ve gizlilik sınırları](docs/PRIVACY-DEMO-RUNBOOK.md).

## İş pazarı ve gerçek testnet kanıtı

`/market` müşteri ve sağlayıcı davetleriyle kalıcı iş/teklif defterini açar.
Gerçek testnet iş #3, üç sağlayıcı hesabıyla FHE/MPC seçimi, makbuz ve müşteri
kabulünü tamamladı; ayrı escrow p2'ye **0,001 test NEAR** ödedi. Final zincir
kaydı, çıktı hash'i ve native Transfer makbuzu bağımsız kontrol edildi.
Bağlantılar: [testnet kanıtları](https://veil-procurement.vercel.app/testnet),
[uygulama durumu](docs/PROCUREMENT-IMPLEMENTATION-STATUS.md),
[teslim raporu](docs/NOPE-TESTNET-TESLIM-RAPORU.md).
Bu koşum yerel MPC ve tek yönetici kullanır; sabit açık test ödemesi gizli
kazanan fiyatla eşitlik ispatı değildir. İş pazarı tüm zincir adımlarını henüz
otomatik yürütmez. `/demo` altındaki eski yerel ödeme fixture'ı ayrı tutulur.

## Davetli bulut istemcisi

[Canlı site](https://veil-procurement.vercel.app) tanıtım sayfasından `/app` bölümüne, oradan istemci indirmesine yönlendirir. İndirilen pakette `sh install-client.sh`, ardından `.venv/bin/python scripts/client-launch.py` çalıştırılır. Davet kodu terminalde gizli olarak girilir; yerel uygulamada bulut hesabı seçilir. Açık kayıtlar tarayıcıdan yalnız `127.0.0.1` istemcisine gider; Vercel'e şifreli girdiler, değerlendirme anahtarları ve hash manifestleri yüklenir. Şifre çözme anahtarı bilgisayardan çıkmaz. Sonuç alınmadan istemci kapatılırsa bellekteki anahtar kaybolur.

Bu yol sabit dört-kayıt devresiyle sınırlıdır. Canlı ödeme veya bağımsız MPC operatörü içermez. Kurulum, davetler, tek kullanımlık iş kotası ve bilinmeyen sonuçların ele alınması: `docs/CLOUD-OPERATIONS.md`. Gerçek testlerin güncel sonucu: `docs/BUILD-STATUS.md`.

## Çalıştırma

Önce desteklenen Python ortamında yerel bağımlılıkları kurun (bu makinede Python 3.9 / Apple Silicon doğrulandı):

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Tam `/demo` ayrıca Rust sandbox ve MP-SPDZ derlemelerini gerektirir; kurulum adımları `integration/README.md` içindedir. Python ortamını proje içinde tutmak, bulut eşitlemeli klasörlerden native modül yükleme gecikmesini önler.

```sh
cd /Users/mete/near-private-procurement
./scripts/run-local.sh
```

Ana sayfa: `http://127.0.0.1:8765/`. Uygulama ayrı `/app` yolundadır. Port için `VEIL_PORT`, Concrete kurulu Python için `VEIL_PYTHON` değişkenleri kullanılabilir. Başlatıcı önce proje `.venv` ortamını, yoksa bu bilgisayardaki doğrulanmış araştırma ortamını kullanır. Gerçek anahtar üretimi ve FHE hesabı ilk istekte zaman alır.

Servis loopback dışına açılmaz. Kayıtlar ve açık sonuçlar kalıcı dosyaya yazılmaz; süreç kapanınca iş geçmişi kaybolur. Şifreli çalışma dosyaları Git dışında `runtime/` altındadır. HTTP servisini internete reverse proxy ile açmak desteklenmez.

## Uçtan uca kontrol

Servis açıkken:

```sh
python3 scripts/verify-http.py
```

Bu komut sentetik veriyle gerçek FHE işi başlatır, bağımsız beklenen çıktıyı ve HTTP güven sınırlarını denetler. Çıktı `runtime/http-fhe-check.json` olur. Testler çalıştırılmadan bu README başarı kanıtı değildir; güncel sonuçlar `docs/BUILD-STATUS.md` içindedir.

## Bileşenler

| Yol | Sorumluluk |
|---|---|
| `web/` | Tanıtım sayfası ve yerel çalışma alanı |
| `service/` | Yerel istemci HTTP arayüzü, kuyruk ve API |
| `engine/` | Sabit FHE devresi, istemci/evaluator ayrımı |
| `contracts/registry/` | NEAR iş/teklif commitment kayıtları |
| `mpc/` | Ayrı çok taraflı gizli teklif hesabı |
| `sdk/` | Motor kayıtlarını NEAR receipt şemasına bağlayan, işlem imzalamayan adaptör |
| `scripts/` | Başlatma ve bağımsız entegrasyon kontrolleri |

NEAR kontratı ve MPC bileşeni `/demo` üzerinden gerçek yerel uçtan uca akışta birlikte çalışır. Gerçek Market ödemesi, bağımsız MPC operatörleri ve attestation/ZK doğrulaması ayrı kabul kapılarıdır. Uygulama desteklemediği yetenekleri hazır göstermez. Ayrıntılar: `docs/INTEGRATION-GATES.md` ve `docs/SECURITY-BOUNDARIES.md`.

FHE parametre/artifact kaynakları mevcut araştırmadan korunarak alınmıştır. Üçüncü taraf yazılım lisansları kendi bileşen belgelerinde yer alır; bu depo üçüncü taraf patent veya ticari kullanım lisansı vermez.

Commitment döngüsünü çözen v2 entegrasyonu `integration/README.md` ve `mpc/V2.md` içindedir. Kalan üretim kapıları `docs/NEXT-INTEGRATION.md` içindedir. Yerel uçtan uca akış, tamamlanmış ticari ödeme ürünü değildir.

Hangi verinin kimden ve hangi kriptografik mekanizmayla gizlendiği `docs/PRIVACY.md` içinde; gerçek testlerin kapsamı ve sonuçları `docs/BUILD-STATUS.md` içindedir.

## Tam akış ve web yayını

Yerel serviste `/demo`, sabit sentetik girdilerle gerçek FHE hazırlama → NEAR sandbox kaydı → üç taraflı MPC → seçilen yürütücü → FHE değerlendirme → istemci doğrulama → kontratta kabul akışını başlatır. Ödeme adımları SQLite fixture simülasyonudur; gerçek para kullanılmaz. Terminal karşılığı: `./scripts/run-integration.sh`.

GitHub deposu `Foreveranka/veil-procurement`, Vercel projesi `veil-procurement` ile bağlıdır. `main` dalına push ana sitenin production dağıtımını tetikler. Build yalnız allowlist web dosyalarını, müşteri istemci paketini ve temizlenmiş **önceden çalıştırılmış yerel/testnet kanıtlarını** yayımlar. Davet denetimli API ayrı serverless fonksiyonudur; `veil-evaluator` projesindeki Linux container şifreli hesabı yürütür. Container ayrı allowlist paketinden dağıtılır; ana sitenin Git push'u onu kendiliğinden güncellemez. Vercel'de MPC operatörleri veya NEAR node çalıştırılmaz; `/demo` kayıtlı yerel kanıttır. Yerel açık-veri API'si internete açılmaz. Ayrıntı: `docs/DEPLOYMENT.md`.
