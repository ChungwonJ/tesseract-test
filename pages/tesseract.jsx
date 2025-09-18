import React, { useState } from 'react';
import Tesseract from 'tesseract.js';
import {
    Box,
    Container,
    Typography,
    Button,
    Paper,
    LinearProgress,
    CircularProgress,
    Alert,
    styled,
} from '@mui/material';

const StyledPaper = styled(Paper)(({ theme }) => ({
    padding: theme.spacing(4),
    marginTop: theme.spacing(4),
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
}));

const ImagePreview = styled('img')({
    maxWidth: '100%',
    maxHeight: '300px',
    margin: '20px 0',
    borderRadius: '8px',
});

const ResultBox = styled(Box)(({ theme }) => ({
    width: '100%',
    marginTop: theme.spacing(3),
    padding: theme.spacing(2),
    backgroundColor: theme.palette.grey[100],
    borderRadius: '8px',
    whiteSpace: 'pre-wrap',
}));

function TesseractPage() {
    const [image, setImage] = useState(null);
    const [result, setResult] = useState('');
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState(null);

    const handleImageUpload = (event) => {
        const file = event.target.files[0];
        if (!file) return;

        setError(null);
        setResult('');
        setImage(URL.createObjectURL(file));
        setLoading(true);
        setProgress(0);

        Tesseract.recognize(file, 'eng+kor', {
            logger: (m) => {
                if (m.status === 'recognizing text') {
                    setProgress(Math.floor(m.progress * 100));
                }
            },
        })
            .then(({ data: { text } }) => {
                setResult(text);
                setLoading(false);
            })
            .catch((err) => {
                setError('텍스트 인식 중 오류가 발생했습니다.');
                setLoading(false);
                console.error(err);
            });
    };

    return (
        <Container maxWidth="md">
            <StyledPaper elevation={3}>
                <Typography variant="h4" component="h1" gutterBottom>
                    이미지 텍스트 인식
                </Typography>

                <Button variant="contained" component="label" sx={{ mt: 2 }}>
                    이미지 업로드
                    <input type="file" hidden accept="image/*" onChange={handleImageUpload} />
                </Button>

                {image && <ImagePreview src={image} alt="업로드된 이미지" />}

                {loading && (
                    <Box sx={{ width: '100%', mt: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                            <Typography variant="body2" color="text.secondary">
                                텍스트 인식 중...
                            </Typography>
                        </Box>
                        <LinearProgress variant="determinate" value={progress} />
                        <Typography variant="body2" color="text.secondary" align="right">
                            {progress}%
                        </Typography>
                    </Box>
                )}

                {error && (
                    <Alert severity="error" sx={{ mt: 2, width: '100%' }}>
                        {error}
                    </Alert>
                )}

                {result && (
                    <ResultBox>
                        <Typography variant="h6" gutterBottom>
                            인식 결과
                        </Typography>
                        <Typography variant="body1">{result}</Typography>
                    </ResultBox>
                )}
            </StyledPaper>
        </Container>
    );
}

export default TesseractPage;