package app.ytlocal.player;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/** Временный файл из внутреннего кэша доступен только получателю, выбранному в системном меню. */
public class ShareProvider extends ContentProvider {
    private static final String AUTHORITY = "app.ytlocal.player.share";

    @Override
    public boolean onCreate() { return true; }

    private File fileFor(Uri uri) throws FileNotFoundException {
        if (!AUTHORITY.equals(uri.getAuthority()) || !"/video".equals(uri.getPath())) {
            throw new FileNotFoundException("Unknown content URI");
        }
        File file = new File(getContext().getCacheDir(), "shared-video");
        if (!file.isFile()) throw new FileNotFoundException("Video no longer available");
        return file;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Read only");
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        try { fileFor(uri); }
        catch (FileNotFoundException e) { return null; }
        return getContext().getSharedPreferences("share", 0).getString("mime", "video/mp4");
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File file;
        try { file = fileFor(uri); }
        catch (FileNotFoundException e) { return null; }
        if (projection == null) {
            projection = new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        }
        MatrixCursor cursor = new MatrixCursor(projection);
        Object[] row = new Object[projection.length];
        for (int i = 0; i < projection.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(projection[i])) {
                row[i] = getContext().getSharedPreferences("share", 0)
                        .getString("name", "video.mp4");
            } else if (OpenableColumns.SIZE.equals(projection[i])) {
                row[i] = file.length();
            }
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection,
                      String[] selectionArgs) { throw new UnsupportedOperationException(); }
}
