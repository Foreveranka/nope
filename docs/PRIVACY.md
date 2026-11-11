# Mahremiyet sözleşmesi — mevcut prototip

Mete'nin isteği: gizli olması gereken bilgi yalnız arayüzden kaldırılmayacak; uygun kriptografik mekanizma ile korunacak. Bu belge kullanıcıya gizlenen alan ile kriptografik olarak gizlenen alanı ayırır. Bütün katmanların üretim entegrasyonu tamamlanmış değildir.

| Bilgi | Kimin açık görmesi gerekir? | Uygulanan mekanizma | Mevcut sınır |
|---|---|---|---|
| Dört kaydın kimliği ve sayısal değeri | Şirketin yerel istemcisi | Concrete FHE; evaluator yalnız ciphertext ve evaluation key alır | Aynı OS kullanıcısı altındaki süreçler izolasyon değildir; profil/kayıt sayısı gizlenmez |
| FHE çözme anahtarı | Yalnız şirket istemcisi | Her iş için yeni anahtar; bellek dışına serialize edilmez | OS/memory ele geçirilmesi ve süreç çökünce kurtarma çözülmez |
| İşlenmiş açık sonuç | Şirket istemcisi | Evaluator şifreli çıktı döndürür; istemci yerelde çözer | Yerel doğruluk karşılaştırması ödeme veya execution proof değildir |
| Satıcının teklif tutarı | Satıcı; kazanırsa alıcı kendi ödediği fiyatı öğrenir | Ayrı malicious SPDZ2k MPC; özel giriş ve alıcıya özel çıktılar | Şu anda üç operatör aynı host üzerinde sentetik test; gerçek işletmeci ayrımı yok |
| Alıcının azami bütçesi | Alıcı | MPC gizli giriş; fiyat+ücret uygunluğu devre içinde hesaplanır | Kazanan/sonuç bilgisi eşitsizlikler açığa çıkarır; yerel kalıcı admission aynı seçimin tekrarını engeller; bağımsız operatör politikası ayrıca gerekir |
| Teklif/bütçe taahhüdü | Açık olabilir | Sürümlü bağlam, slot, kanonik tutar ve gizli rastgele 32-byte salt içeren SHA-256 | Salt gizli kalmalı; düz `SHA256(fiyat)` kullanılmaz. V2 intent commitment ve tam bidset yerel entegrasyonda registry ile doğrulanır; gerçek zincir finality kaynağı ayrıca gerekir |
| MPC uçları arasındaki taşıma ve katılımcı kimliği | Yetkili uçlar | TLS, sertifika zinciri ve beklenen peer leaf sertifikasının birebir eşleşmesi | Yeni TLS düzeltmesinin sonuçları `mpc/VERIFICATION.md` içinde; root/leaf anahtarları yerel test kimlikleridir |
| Zincirde iş, taraf ve zaman metadata'sı | Kamuya açık | İçerik yerine hash/commitment; yetki ve durum geçişleri kontratta | Hash, taraf hesabını/işlem zamanını anonimleştirmez. Ciphertext yerine hash yazılması metadata gizliliği değildir |

## Hash ile şifrelemenin ayrımı

Hash dosyanın/işin aynı olduğunu bağlamak içindir; içeriği sonradan çözmek için değildir. Küçük bir fiyat kümesinin saltsız hash'i bütün fiyatlar denenerek bulunabilir. Bu nedenle gizli tutar commitment'i, o katılımcının ürettiği tahmin edilemez salt içerir. Tuzun açık tutulması aynı sözlük saldırısını yeniden mümkün kılar.

FHE dosya işi ve MPC ihale işi farklı anahtar/tehdit modelleridir. Tek bir müşterinin çözme anahtarını tuttuğu FHE devresine tüm satıcıların teklifini koymak, teklifleri o müşteriden gizlemez. Mevcut tasarım bu iki işi ayrı mekanizmalarla ele alır.

## Açığa çıkanlar ve güven varsayımları

Tarayıcıdan şirketin kendi Python servisine giden ilk veri `127.0.0.1` üzerindeki HTTP isteğidir; bu bağlantı TLS kullanmaz. Host/Origin/CSRF koruması başka sitelerin erişimini sınırlar, yerel işletim sistemi saldırganına karşı şifreleme sağlamaz. Verinin açık hâli bu şirket bilgisayarının güven alanında bulunur; dış evaluator'a hazırlanırken FHE ile şifrelenir. Servisi uzak hosta/reverse proxy'ye taşımak bu güven varsayımını değiştirir ve desteklenen dağıtım değildir.

MPC alıcıya kazananın kimliğini, kazanan fiyatı ve ücretli toplamı verir; her satıcı yalnız kazanıp kazanmadığını ve kazandıysa kendi fiyatını alır. Hiç kazanan olmaması da bilgidir. Katılımcı listesi, qualification bayrakları, devre, genel tutar aralığı ve sabit ücret gizli değildir. Bu prototip erişim örüntüsü, zamanlama ve trafik boyutu gizliliği sağlamaz.

MPC protokolünün amaçlanan güven modeli en az bir dürüst operatör gerektirir ve abort'a izin verir. Aynı Mac üzerinde bütün süreçleri başlatmak bu bağımsızlığı sağlamaz. Test harness'i sentetik girdilerin tamamını bilir ve gerçek gizli teklif koordinatörü olarak kullanılmamalıdır.

Şifreleme yanlış bir işlemin doğru olduğunu ispatlamaz. Receipt hash'i, TLS kimliği ve buyer kabulü attestation/ZK yerine geçmez. Gerçek ödeme/uyuşmazlık için kalan kapılar ve uygulanmış v2 commitment sırası `NEXT-INTEGRATION.md` içinde kayıtlıdır. İlgili test geçmeden bir kapı kapatılmaz; bütün sisteme "kırılamaz" veya "hiçbir şey sızdırmaz" etiketi verilmez.
