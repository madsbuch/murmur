use crate::files::FileContent;
use tauri::AppHandle;

#[cfg(desktop)]
mod desktop {
    use super::*;
    use crate::files::MAX_FILE_BYTES;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::io::Cursor;
    use tauri_plugin_clipboard_manager::ClipboardExt;

    fn check_dimensions(width: u32, height: u32) -> Result<(), String> {
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 40_000_000 {
            return Err("Choose an image smaller than 40 megapixels.".into());
        }
        Ok(())
    }

    fn encode(image: &tauri::image::Image<'_>) -> Result<FileContent, String> {
        check_dimensions(image.width(), image.height())?;
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, image.width(), image.height());
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .map_err(|error| error.to_string())?
                .write_image_data(image.rgba())
                .map_err(|error| error.to_string())?;
        }
        if bytes.len() > MAX_FILE_BYTES {
            return Err("The clipboard image exceeds the 25 MB file limit.".into());
        }
        Ok(FileContent {
            name: "Clipboard image.png".into(),
            mime_type: "image/png".into(),
            data_base64: STANDARD.encode(bytes),
        })
    }

    fn decode(data: &str) -> Result<tauri::image::Image<'static>, String> {
        if data.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
            return Err("The image exceeds the 25 MB clipboard limit.".into());
        }
        let bytes = STANDARD
            .decode(data)
            .map_err(|_| "The image data could not be read.")?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err("The image exceeds the 25 MB clipboard limit.".into());
        }
        let mut decoder = png::Decoder::new(Cursor::new(&bytes));
        let info = decoder
            .read_header_info()
            .map_err(|_| "The clipboard image must be a valid PNG.")?;
        check_dimensions(info.width, info.height)?;
        tauri::image::Image::from_bytes(&bytes).map_err(|error| error.to_string())
    }

    pub async fn read(app: AppHandle) -> Result<FileContent, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let image = app
                .clipboard()
                .read_image()
                .map_err(|_| "There is no readable image on the clipboard. Copy an image first.")?;
            encode(&image)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    pub async fn write(app: AppHandle, data: String) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let image = decode(&data)?;
            app.clipboard()
                .write_image(&image)
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn clipboard_png_preserves_pixels_and_rejects_invalid_images() {
            let image =
                tauri::image::Image::new_owned(vec![255, 0, 0, 255, 0, 100, 200, 128], 2, 1);
            let content = encode(&image).unwrap();
            let restored = decode(&content.data_base64).unwrap();
            assert_eq!(restored.rgba(), image.rgba());
            assert_eq!((restored.width(), restored.height()), (2, 1));
            assert!(decode("bm90IGEgcG5n").is_err());
            assert!(decode("not base64").is_err());
            assert!(check_dimensions(0, 1).is_err());
            assert!(check_dimensions(10_000, 10_000).is_err());
        }
    }
}

pub async fn read(app: AppHandle) -> Result<FileContent, String> {
    #[cfg(desktop)]
    {
        desktop::read(app).await
    }
    #[cfg(target_os = "android")]
    {
        crate::native_shares::read_clipboard(&app).await
    }
    #[cfg(target_os = "ios")]
    {
        crate::apple_shares::read_clipboard(&app).await
    }
}

pub async fn write(app: AppHandle, data: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        desktop::write(app, data).await
    }
    #[cfg(target_os = "android")]
    {
        crate::native_shares::write_clipboard(&app, data).await
    }
    #[cfg(target_os = "ios")]
    {
        crate::apple_shares::write_clipboard(&app, data).await
    }
}
