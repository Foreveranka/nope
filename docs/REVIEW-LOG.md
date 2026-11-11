# Entegrasyon inceleme kaydı — 11 Kasım 2026

Bu kayıt yapılan incelemeleri, değişiklik taleplerini ve sonuç kanıtlarını ayırır.

1. **Anahtar/istemci ayrımı:** FHE worker'ın yeni interpreter ile başladığı, plaintext argüman ve SK dosyası almadığı incelendi. Bu aynı UID altında OS izolasyonu anlamına gelmez. Worker'ın yüklediği sabit artifact byte'ları pinli hash ile doğrulanır.
2. **Taşınabilir interpreter:** Worker'ın araştırma klasöründeki sabit Python yerine doğrulanmış mevcut interpreter'ı kullanması istendi; ayrıca açık override desteklenir.
3. **Disk büyümesi:** Her işin yaklaşık 221 MB değerlendirme anahtarının işlem sonunda `finally` ile kaldırılması istendi. Hash kaydı anahtar dosyasının arşivlendiği anlamına gelmez.
4. **Kuyruk/geçmiş:** Tek FHE işçisi, 8 etkin iş sınırı; tamamlanan işlerin bellekte sınırsız birikmemesi için oturum sınırı eklendi.
5. **NEAR durumları:** Yürütücünün yarıda bıraktığı işin `Executing` durumunda kalması tespit edildi. İzin gerektirmeyen son tarihli `expire_job` ve geç callback/retry sınır testleri istendi.
6. **NEAR bütünlüğü:** Buyer, son tarih öncesinde kapanış yapamamalı; tüm kabul edilmiş commitment'ler deterministik roster sırasıyla köke girmeli; job/attempt/input/circuit/key/output-policy bağları değiştirilememeli. Sadece executor beyanı, doğrulanmış execution proof olarak etiketlenmez.
7. **MPC bağlamı:** İnsan tarafından verilen job adı tek başına NEAR ağ/kontrat/manifest bağı değildir. Registry binding hash'lerine gelecekte bağlanma şartı ve TLS client-slot kimliği ayrıca belirtilmeli.
8. **HTTP ilk deneme:** 15 sınır/başlatma kontrolü geçti; gerçek FHE işi şifreleme aşamasında başarısız oldu. İlk başarısız çıktı `runtime/http-fhe-check-initial-failure.json` içinde korundu. Motor düzeltmesi ve tekrar gerçek test gerekiyor.
9. **Gerçek tarayıcı hatası:** İlk Chrome üst sayfa gezinmesinde katı `Sec-Fetch-Site` kontrolü ana sayfayı da engelledi. Yalnız public HTML üst sayfa gezinmesi için dar istisna istendi; API/cross-site iframe/mutation koruması korunmalı.
10. **Servis testleri:** İlk çalıştırmada 13 servis birim testi geçti; bu testler enjekte edilen test pipeline'ı kullanır, gerçek FHE kanıtı değildir.

Kapsam: hedefli kaynak incelemesi ve çalıştırılan testler. Bağımsız kriptografik ispat/production güvenlik denetimi değildir.

## Doğrulanmış sonraki sonuçlar

- Servis düzeltmeleri sonrası **14/14** test geçti; public HTML üst sayfa gezinmesi açılırken API/iframe koruması korundu.
- Motor ajanının gerçek FHE dahil **23/23** test çalıştırması geçti. Ana incelemenin ayrı saf unit çalıştırmasında gerçek FHE testi bilerek atlandı; bunu ek bağımsız FHE koşumu saymıyoruz.
- Bağımsız HTTP entegrasyonunda **20/20** kontrol geçti, gerçek iş **10.201 s** sürdü. Kanıt: `verification/http-fhe-check.json`.
- Tarayıcıdan ayrı sentetik örnek gerçekten **12.511 s** içinde tamamlandı. Yinelenen kayıt ve dönüşümler UI'da doğru görüldü; 256 girdisi engellendi, CSV tabı ve 390px yerleşimi kontrol edildi. Kanıt: `verification/browser-check.json`.
- UI modülünün static allowlist yolu eksikliği giderildi. Yetenek panelindeki eski `pending` durumu için iş tamamlanınca/panel açılınca tek seferlik güncelleme eklendi; yeniden yükleme sonrası `available` doğrulandı.
- Frontend girdi/CSV/metric semantik testleri **8/8** geçti.

- NEAR registry ajanı 18 Rust + 1 Wasm + 2 gerçek yerel sandbox testi tamamladı. Ana ajan mevcut sandbox kanıtının job/bidset/attempt/receipt, Wasm ve kaynak SHA bağlarını yeniden hesapladı: 6/6 geçti. Bu ikinci bir node koşumu değildir.
- SDK için ana ajan 26 testi çalıştırdı: hepsi geçti. SDK plaintext kayıtlarına dokunmuyor ve işlem imzalamıyor; taze/güvenilir registry kaynağı ve yerel engine/NEAR attempt ayrımı dokümante.
- MPC v1 commitment/registry bağlamında döngü riski somutlaştırıldı; uygulanmamış V2 çözüm sırası `NEXT-INTEGRATION.md` içinde. Mevcut MPC doğru olsa bile NEAR özel ihale entegrasyonu hazır sayılmaz.

## MPC TLS kimliği — somut inceleme bulgusu

`openssl req -x509` için kullanılan host varsayılanı `v3_ca` / `CA:TRUE` üretiyordu. Tüm client sertifikaları trust store'a konduğundan, yalnız isim + chain kontrolü beklenen özel katılımcı kimliğini garanti etmiyordu. Ana ajan sentetik C0 sertifikasıyla sahte C1 leaf imzaladı; `openssl verify -CAfile C0.pem -verify_hostname C1 fake.pem` başarılı oldu. Bu gerçek MPC bağlantısı değil, kullanılan trust modelinin bağımsız OpenSSL yeniden üretimidir. Tüm deney anahtarları hemen silindi. Kanıt: `verification/tls-default-ca-review.json`.

MPC ajanına açık CA:FALSE ve server tarafında beklenen peer leaf sertifikasının tam eşleşmesi istendi. Düzeltme ve negatif TLS koşumu tamamlanana kadar client-slot kimlik kapısı açık sayılır. Eski olumlu aritmetik koşumları bu düzeltmenin testi değildir.

## TLS bulgusunun kapatılması ve son MPC kanıtı

- Native TLS callback normal chain/hostname kontrolüne ek olarak beklenen leaf sertifikanın tam DER byte eşleşmesini uygular. Parent kaynak incelemesi yapıldı.
- Host Python LibreSSL 2.8.3'ün doğrudan CA olmayan self-signed leaf güveni, ayrı yerel TLS deneyinde başarısız oldu (`verification/tls-libressl-leaf-review.json`). Doğrulama kapatılmadı; her oturuma özgü fixture CA ile CA:FALSE leaf zinciri kuruldu. CA private key hiçbir katılımcıya dağıtılmadan silinir.
- Gerçek patched MP-SPDZ TLS sınıfıyla beş test: doğru sertifika geçti; yanlış slot, eksik sertifika, güvensiz aynı ad ve güvenilen C0 CA'nın imzaladığı sahte C1 reddedildi. Son saldırının chain+hostname kontrolünden geçtiği ayrıca doğrulandı; dolayısıyla test yalnız CA:FALSE sayesinde reddi ölçmüyor.
- Aynı nihai devre kaynağında 11 MPC senaryosunun açık beklenen sonuçları / üç party log'u / anahtar temizliği ana ajan tarafından denetlendi. TLS sonrası güncel shared library ile bir olumlu ve bir bozuk commitment koşumu tekrar geçti. Bunlar bağımsız operatör veya NEAR entegrasyon kanıtı değildir.
- Ana ajanın 12 codec/wire/cleanup birim testi ve 15 TLS/native artifact/sonuç/log/temizlik kontrolü geçti. Önceki başarısız koşumun geçici anahtarları da kaldırıldı. Ayrı bir ikinci native TLS/MPC koşumu yapıldı iddiası yok; yeniden hesaplanan kanıt ve gerçek alt ajan koşumları ayrı kaydedildi.
- FHE artifact'ini üreten iki incelenmiş tarihsel kaynak `.py.txt` olarak `engine/provenance/` altında byte-identical arşivlendi. Araştırma asılları değişmedi, bu dosyalar import/execute edilmedi.
