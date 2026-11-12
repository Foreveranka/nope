# NOPE Privacy demosu — operatör akışı

Bu sayfa sentetik verilerle gerçek FHE, gerçek üç taraflı yerel MPC ve NEAR
testnet teslim kabulü/escrow ödemesini tek koşumda birleştirir. Genel amaçlı,
bağımsız operatörlü müşteri pazarı değildir.

## Başlatma

Mevcut yapılandırılmış operatör deposunda:

```sh
.venv/bin/python scripts/privacy-demo-launch.py
```

Açılan `http://127.0.0.1:8766/privacy` sayfasındaki testnet onayını seçip başlatın.
Başlatma yalnız yerel Origin ve CSRF doğrulamasıyla, boş istek gövdesiyle yapılır.
Girdi, dosya yolu, komut veya ödeme adresi tarayıcıdan değiştirilemez. Testnet
cüzdanı kaynak depoda değil, hariç tutulan yerel çalışma dizinindedir.

Demo gerçek teklif süresini bekler; sayfa gerçek olayları sorgular. Bekleme
sırasında yeniden başlatılmaz. Cevabı belirsiz zincir işlemi tekrar imzalanmaz.
Yerel `runtime/privacy-demo-active.json` başlangıç kaydı fsync ile tutulur;
süreç yeniden açıldığında yeni iş veya ödeme otomatik başlatılmaz. Tamamlanmış
koşumun yalnız açık, sentetik sonucu yeniden görüntülenir; yarım koşum
kesintiye uğramış olarak kalır. Bu kaydı
silerek belirsiz işlemi tekrar denemeyin. Önce kayıtlı hash ve makbuzları okuyun.

İnternetteki `/privacy` sayfası tamamlanmış koşumun açık kanıtlarını gösterir.
Bu kayıt tekrar oynatımıdır; ziyaretçinin tarayıcısı proje cüzdanıyla işlem yapmaz.
Müşteri istemcisi ZIP'i özel cüzdanı veya native MPC operatör kurulumunu içermez.

## Gösterilecek ayrımlar

- Sabit dört kayıt gerçekten şifrelenir. Yürütücü sürece açık veri/çözme anahtarı
  verilmez; müşteri tarafı sonucu çözüp referansla karşılaştırır.
- Üç teklif ve bütçe gerçek MPC devresinde karşılaştırılır. Bu koşumun sentetik
  girdilerini hazırlayan operatör hepsini bilir; bağımsız taraf gizliliği kanıtı değildir.
- İş, teklifler, seçilen sağlayıcı, makbuz ve kabul gerçek testnet işlemleridir.
- Escrow ödemesi 0,001 test NEAR sabit açık demo bedelidir. Gizli kazanan fiyatın
  ödemeyle eşitliğini kanıtlamaz. Ücret, alıcı ve zamanlama zincirde görünür.
- Makbuz bağlama ve yerel sonuç kontrolü, genel ZK yürütme ispatı değildir.

## Sunum

1. Kim neyi görebilir tablosunu gösterin.
2. Sentetik girdi gösterimini açın; gerçek müşteri verisi olmadığını belirtin.
3. Yerel koşumu başlatıp şifreleme → taahhüt → kapanış → MPC → hesap → kabul → ödeme
   adımlarını izleyin. Akış bitmeden başarı ilan etmeyin.
4. Çözülen gerçek sonuçları ve testnet işlem bağlantılarını açın.
5. Ortak yönetim, sabit profil ve açık ödeme sınırlarını söyleyin.

## Doğrulanmış tarayıcı koşumu

12 Kasım 2026: yerel tarayıcıdaki gerçek düğme ile başlatılan iş **#5**,
292,80 saniyede tamamlandı. Üç teklif, gerçek FHE/MPC, müşteri kabulü,
0,001 test NEAR escrow ödemesi ve bağımsız Python RPC/makbuz kontrolü geçti.
Toplam 10 ayrı FINAL işlem vardır. Önceki iş #3 ödeme kanıtları byte-exact
korundu. Kamuya açılan özet `verification/privacy-demo-public.json`; yerel
kanıt dosyalarının hash manifesti `verification/privacy-demo-evidence-manifest.json`.
Bu kontrol güvenilen RPC üzerinden yapılır; bağımsız light-client ispatı değildir.

Servis durdurulup gerçek başlatıcıyla yeniden açıldı: aynı iş #5 tamamlanmış
olarak geri yüklendi, altı kanıt dosyasının SHA-256 değeri değişmedi ve yeni
koşum/ödeme gönderilmedi. 44 servis/runner testi, 20 testnet sürücü testi ve
139 JavaScript testi geçti; 8 ek seçim/taşıma testi içinde 1 opt-in sandbox
testi atlandı. İndirilebilir istemci temiz geçici dizinde açılıp sunucu
modülü başlatıldı; ödeme başlatıcısı bu müşteri paketinde kapalıdır.
