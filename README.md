# NOPE — Network of Private Execution

Müşteri verisini ajana veya hizmet sağlayıcıya açık hâliyle vermeden, gizli tekliflerle sınırlı veri temizleme işleri yaptıran NEAR testnet uygulaması.

[Projeyi aç](https://veil-procurement.vercel.app) · [Çalışma alanı](https://veil-procurement.vercel.app/workspace) · [Gerçek işin sonuç kanıtını doğrula](https://veil-procurement.vercel.app/verify?id=558a4098ab50abba0501d4cd32760cd3)

## Güncel tarayıcı akışı

1. Müşteri CSV’yi kendi tarayıcısında açar. Yerel LLM yalnız herkese açık hedefi ve `C1/C2` gibi anonim sütun türlerini alır. Dosya, özgün başlıklar, örnek satırlar ve gizli anahtarlar modele verilmez. Müşteri önerilen planı ve yerel önce/sonra görünümünü onaylar.
2. Tarayıcı gerçek tek kullanımlık garbled circuit’i ve v4 için gizli eşleme taahhütlerini hazırlar. Orijinal dosya, çözücü ve kanıt tanığı yerel şifreli kasada kalır. Kurulum veya müşteri companion uygulaması gerekmez.
3. Sağlayıcılar şifreli teklif gönderir. Müşteri kapanıştan sonra teklifleri kendi cihazında açar ve sağlayıcı seçer. Diğer teklif verenler rakip teklifleri açamaz. Seçilen sağlayıcı ve tutar testnet escrow için herkese açık olur.
4. Sonlu sponsor testNEAR havuzundan fon kesinleşince sağlayıcı gerçek şifreli hesabı tetikler. Teslimin sürümü/özeti NEAR’a kaydedilir. Müşteri sonucu uygulama içinde açıp denetler; CSV indirmek isteğe bağlıdır.
5. Yeni v4 ajan işinde müşteri tarayıcısı gerçek Noir/UltraHonk sonuç kanıtlarını üretir. Tarayıcı ve sunucu tüm hücreleri ayrı doğrular. Eksik, bozuk veya önceki teslimin kanıtı kabulü/ödemeyi açmaz. Sayfa yenilenince kanıt yeniden doğrulanır.
6. Müşteri açıkça kabul edince testnet native transferi ve başarılı callback kesinleşir. Sessizlik ödeme başlatmaz. Süre sonrası iade sponsor havuzuna döner. Mainnet veya gerçek para kullanılmaz.

`/verify?id=…` yalnız herkese açık şifreli kayıt, gerçek kanıt ve sabitlenmiş sözleşmenin kesinleşmiş RPC kaydıyla bağımsız doğrulama yapar; müşteri CSV’sini, çözücüsünü veya gizli eşlemeyi almaz. Testnet sözleşmesi `nope-work-da4cbb1e.testnet`tir. Bu uygulama, eski `/market` demo sözleşmelerinden ayrıdır.

## Dil seçimi

Arayüz Türkçe, İngilizce, Almanca, İspanyolca ve Fransızcadır. İlk dil IP ülkesinden seçilir: Türkiye/Türkçe, Almanya/Almanca, İspanya/İspanyolca, Fransa/Fransızca; diğer ülkeler/İngilizce. Menüden yapılan dil seçimi hatırlanır. Dil değişimi formu yenilemez ve müşteri verisini çevirmeye göndermez. [Uygulama ayrıntıları](docs/LOCALIZATION.md).

## Kapsam ve ispat sınırı

Desteklenen araçlar sayı için boş değer doldurma/aralığa sınırlama; ASCII metin için baş/son boşluk silme, küçük/büyük harf ve rakam maskelemedir. En fazla4 sütun,32 sayısal satır,8 metin satırı,16 bayt metin hücresi ve40 işlenen hücre kanıtı desteklenir; ayrıca devre/istek sınırları uygulanır. Diğer sütunlar yerelde korunur. Bu, keyfî belgeler üzerinde genel gizli AI değildir. Yerel küçük modelin doğal dil yorumu yanılabilir; plan/sonuç önizlemesini onaylamak zorunludur.

Sonuç SNARK’ı, önceden sabitlenen dürüst müşteri eşlemesi altında teslim edilen etiketlerin onaylı işlemin doğru sonucunu temsil ettiğini ispatlar. Özgün CSV kaynağını, AES yürütme izini, sağlayıcının fiziksel hesabını veya LLM niyet yorumunu ispatlamaz. Sözleşme taahhüt ve teslimi bağlar; SNARK doğrulayıcısı tarayıcı/sunucudadır. RPC, frontend ve backend yetkilendirme güven sınırları devam eder. Bağımsız operatör ağı ve otomatik uyuşmazlık çözümü henüz yoktur.

## Doğrulama ve geliştirme

Gerçek Chrome yerel ajan → v4 şifreli teslim → altı gerçek satır kanıtı → bağımsız doğrulama → gerçek testnet ödeme akışını geçti. Canlı Vercel HTTP akışı ve canlı genel doğrulayıcı da ayrıca sınandı. Ödeme için ayrı salt-okunur Python gözlemcisi tek native Transfer ve doğru callback’i kontrol eder. Test çiftleri bu gerçek kayıtlarla karıştırılmaz.

- [Gerçek Chrome kaydı](docs/execution-proof/browser-local.json), [canlı HTTP kaydı](docs/execution-proof/http-testnet-production.json), [bağımsız zincir gözlemi](docs/execution-proof/independent-chain-production.json).
- [Güncel entegrasyon ve güven sınırları](docs/execution-proof/INTEGRATION.md), [kriptografik protokol](docs/execution-proof/PROTOCOL.md), [gerçek SDK ve maliyetler](docs/execution-proof/IMPLEMENTATION.md).

```sh
npm ci
npm ci --prefix planner-runtime --ignore-scripts
npm ci --prefix proof-runtime --ignore-scripts
npm test
npm run test:proof
npm run build
```

GitHub main, mevcut özel Vercel projesine otomatik dağıtılır. Marka NOPE’dir; eski GitHub/Vercel adresleri ve yapılandırma adları uyumluluk için korunur. Ortam değerleri, hesap anahtarları, yerel veri kasaları ve `runtime/` Git/dağıtım paketine alınmaz.

---

Aşağıdaki yollar önceki sabit GC/Concrete FHE/MPC deneyleridir. Güncel tarayıcı akışı ve v4 sonuç kanıtı yukarıda anlatılır; eski sınırlar güncel akışın tamamını tanımlamaz.

## Önceki sabit CSV yolu

[CSV çalışma alanı](https://veil-procurement.vercel.app/csv) kurulum veya davet
kodu istemeden tarayıcıda gizli etiketler üretir; Vercel şifreli devreyi
çalıştırır; tarayıcı sonucu açıp CSV indirir. Bu yol **garbled circuits**
kullanır; Concrete FHE değildir. 1–32 satır; seçilen sayısal sütunda boş→0,
100 üstü→100; diğer hücreler ve sıra korunur. Tek kullanımlık devre, AES-GCM
etiketleri ve sonuç eşlemesi istemciye aittir. [Protokol ve sınırlar](docs/BROWSER-CSV-GC.md).

Genel [doğrulayıcının](https://veil-procurement.vercel.app/verify) “Önceki sürümler” bölümü bu eski şifreli devreyi
tekrar çalıştırabilir ve ayrı testnet kaydı varsa manifest hash'ini karşılaştırır.
Bu eski pakette ZK yoktur; yeni v4 sonuç SNARK’ından ayrıdır. Eski Concrete yolu isteğe bağlı müşteri
istemcisinin `/csv-local` sayfasında korunur.

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

Önceki davetli FHE yolu `/app` bölümünde istemci indirmesi kullanır; güncel `/workspace` akışı kurulum gerektirmez. İndirilen pakette `sh install-client.sh`, ardından `.venv/bin/python scripts/client-launch.py` çalıştırılır. Davet kodu terminalde gizli olarak girilir; yerel uygulamada bulut hesabı seçilir. Açık kayıtlar tarayıcıdan yalnız `127.0.0.1` istemcisine gider; Vercel'e şifreli girdiler, değerlendirme anahtarları ve hash manifestleri yüklenir. Şifre çözme anahtarı bilgisayardan çıkmaz. Sonuç alınmadan istemci kapatılırsa bellekteki anahtar kaybolur.

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
