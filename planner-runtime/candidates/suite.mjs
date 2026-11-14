/** Frozen public synthetic semantic tests. Expected answers never enter a prompt. */
const t=(id,type)=>({id,type});
const step=(column,type,...ops)=>({column,recipe:{type,steps:ops.map(x=>typeof x==='string'?{op:x}:x)}});
const fill=value=>({op:'fill',value}),clamp=(min,max)=>({op:'clamp',min,max});
const positive=(id,lang,split,goal,columns,steps)=>({id,lang,split,kind:'supported',task:{version:1,goal,columns},expected:{steps}});
const negative=(id,lang,split,goal,columns)=>({id,lang,split,kind:'unsupported',task:{version:1,goal,columns}});
export const suite=[
positive('P01','en','development','For C2, trim leading and trailing spaces and lowercase. For C3, replace empty values with 0 then clamp between 0 and 100.',[t('C2','text'),t('C3','number')],[step('C2','text','trim','lowercase'),step('C3','number',fill(0),clamp(0,100))]),
positive('P02','tr','development','C5 yazısının iki ucundaki boşlukları kaldır ve küçük harf yap. C12 içindeki eksikleri 11 ile doldur; sonra 3 ile 140 arasında tut.',[t('C5','text'),t('C12','number')],[step('C5','text','trim','lowercase'),step('C12','number',fill(11),clamp(3,140))]),
positive('P03','en','development','Make C8 uppercase, then replace every digit with an asterisk. Leave its surrounding spaces alone.',[t('C8','text')],[step('C8','text','uppercase','redactDigits')]),
positive('P04','tr','development','C14 metnindeki rakamları yıldızla maskele, ardından harfleri büyüt.',[t('C14','text')],[step('C14','text','redactDigits','uppercase')]),
positive('P05','en','development','Only cap the numeric C16 values to the range 13 through 201; make no changes to C7.',[t('C7','text'),t('C16','number')],[step('C16','number',clamp(13,201))]),
positive('P06','tr','development','C11 sayısal sütununda yalnız eksik değerlerin yerine 254 koy. Başka dönüşüm uygulama.',[t('C11','number')],[step('C11','number',fill(254))]),
positive('P07','en','development','First lowercase C4, then strip its edge spaces. For C6, substitute 19 for missing values and afterwards limit values to 27..93.',[t('C4','text'),t('C6','number')],[step('C4','text','lowercase','trim'),step('C6','number',fill(19),clamp(27,93))]),
positive('P08','tr','development','C10 harflerini büyük yap. C15 için işlem sırası: önce 4 ile 180 arasına sınırla, sonra eksikleri 6 ile doldur.',[t('C10','text'),t('C15','number')],[step('C10','text','uppercase'),step('C15','number',clamp(4,180),fill(6))]),
positive('P09','en','holdout','Clean three columns: remove edge spaces in C1; use 23 for absent numbers in C9; convert letters in C13 to lowercase.',[t('C1','text'),t('C9','number'),t('C13','text')],[step('C1','text','trim'),step('C9','number',fill(23)),step('C13','text','lowercase')]),
positive('P10','tr','holdout','C6 içindeki kelimelerin arasına dokunma; yalnız baş ve sondaki boşlukları kırp.',[t('C6','text')],[step('C6','text','trim')]),
positive('P11','en','holdout','In C2 hide each numeral by changing it to *, preserving letters and spaces.',[t('C2','text')],[step('C2','text','redactDigits')]),
positive('P12','tr','holdout','C7 metnini küçük harfe dönüştür. C16 sayılarında eksikleri sıfırla doldurup değerleri sıfır ile 254 arasında sınırla.',[t('C7','text'),t('C16','number')],[step('C7','text','lowercase'),step('C16','number',fill(0),clamp(0,254))]),
positive('P13','en','holdout','Apply exactly this sequence to C15: uppercase, lowercase, mask digits, trim edge spaces.',[t('C15','text')],[step('C15','text','uppercase','lowercase','redactDigits','trim')]),
positive('P14','tr','holdout','C2 sayısında boşları 7 ile doldur, ardından 10 ile 80 arasına sınırla. C3 metnini önce büyüt, sonra uç boşluklarını kaldır.',[t('C2','number'),t('C3','text')],[step('C2','number',fill(7),clamp(10,80)),step('C3','text','uppercase','trim')]),
positive('P15','en','holdout','For C9 use 42 for absent entries. After that, values below 20 must become 20 and values above 130 must become 130.',[t('C9','number')],[step('C9','number',fill(42),clamp(20,130))]),
positive('P16','tr','holdout','C4 sayılarındaki boşların yerine 5 koy; sonra 40 altını 40, 210 üstünü 210 yap. C1 yazısını küçük harfe çevirip baş ve son boşluklarını sil.',[t('C1','text'),t('C4','number')],[step('C4','number',fill(5),clamp(40,210)),step('C1','text','lowercase','trim')]),
negative('N01','en','development','Trim C2, then translate the result into Turkish.',[t('C2','text')]),
negative('N02','tr','development','C8 boşluklarını kaldır, küçük harf yap ve cümlenin olumlu mu olumsuz mu olduğunu söyle.',[t('C8','text')]),
negative('N03','en','development','Fill C12 missing numbers with 4, then remove duplicate rows.',[t('C12','number')]),
negative('N04','tr','development','C5 metnini özetle.',[t('C5','text')]),
negative('N05','en','holdout','Convert C7 to uppercase and sort the rows alphabetically.',[t('C7','text')]),
negative('N06','tr','holdout','C3 metnini İngilizceye çevir ve rakamlarını maskele.',[t('C3','text')]),
negative('N07','en','holdout','Add 5 to every C16 value, then clamp the result between 10 and 80.',[t('C16','number')]),
negative('N08','tr','holdout','C1 metnini Türkçe dil kurallarıyla büyük harfe çevir: i harfi İ, ı harfi I olmalı.',[t('C1','text')]),
];
