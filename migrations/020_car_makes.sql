-- Danh sách HÃNG XE (mã của các hãng này = mã chính hãng). Tab "Mã thay thế" dùng
-- bảng này để tách mã chính hãng / mã hãng phụ tùng ngoài. Trước đây so với
-- DISTINCT make của catalog_vehicles (chỉ 21 hãng có xe trong DB) nên mã Mopar,
-- VAG, BMW, Ford, "Hyundai / Kia"... bị xếp nhầm là hàng phụ tùng ngoài.
-- Tên viết đúng như catalog_oem_codes.make sau scripts/normalize-oem-make.cjs; so
-- khớp không phân biệt hoa/thường.
CREATE TABLE IF NOT EXISTS catalog_car_makes (make text PRIMARY KEY);

INSERT INTO catalog_car_makes (make) SELECT lower(m) FROM unnest(ARRAY[
  'Acura','Alfa Romeo','AMC Jeep','Asia Motors','Aston Martin','Audi','BAIC','Baojun (SGMW)',
  'Bedford','BMW','Brilliance','Buick','BYD','Cadillac','Changan','Chery','Chevrolet','Chrysler',
  'Citroen','Dacia','Daewoo','DAF','Daihatsu','Dodge','Dongfeng','FAW','FAW-VW','Ferrari','Fiat',
  'Ford','Foton','Fuso','GAC Motor','GAZ','GAZ / UAZ','Geely','GM','Great Wall','Haval','Hino',
  'Honda','Hongqi','Hyundai','Hyundai / Kia','Infiniti','Isuzu','Iveco','JAC','Jaguar','Jeep',
  'Jetour','JMC','Kia','Lada','Lamborghini','Lancia','Land Rover','Lexus','Lifan','Livan','Lixiang',
  'Lotus','MAN','Maruti','Maxus','Mazda','Mazda (Changan)','Mazda (FAW)','Mercedes','MG','Mini',
  'Mitsubishi','Mobis','Mopar','Nissan','Nissan UD','Opel','Perodua','Peugeot','Peugeot / Citroen',
  'Plymouth','Pontiac','Porsche','Proton','Renault','Renault Samsung','Rover','Saab','Saab Scania',
  'SAIC','SAIC Volkswagen','Santana','Scania','Seat','Skoda','Smart','Ssangyong','Subaru','Suzuki',
  'Talbot','Tata','Tesla','Toyota','UAZ','VAG','Vauxhall','Volkswagen','Volvo','Voyah','Wuling (SGMW)',
  'Yue Loong'
]) m ON CONFLICT DO NOTHING;
